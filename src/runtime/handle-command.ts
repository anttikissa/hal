import { resolve, isAbsolute } from 'path'
import { rename } from 'fs/promises'
import type { RuntimeCommand } from '../protocol.ts'
import { clearSession, performHandoff, saveSession, saveSessionInfo, extractLastPrompt, appendConversation, makeSessionId } from '../session.ts'
import { sessionDir } from '../state.ts'
import {
	loadConfig,
	resolveModel,
	resolveCompactModel,
	providerForModel,
	modelIdForModel,
	MODEL_ALIASES,
} from '../config.ts'
import { getProvider } from '../provider.ts'
import { drainQueuedCommands, pauseSession } from './command-scheduler.ts'
import {
	publishLine,
	publishCommandPhase,
	publishActivity,
	publishContext,
} from './event-publisher.ts'
import { processPrompt } from './process-prompt.ts'
import {
	estimateMessageTokens,
	MAX_CONTEXT,
} from '../context.ts'
import { estimateTokensSync, getTokenCalibration } from '../token-calibration.ts'
import {
	getOrLoadSessionRuntime,
	getCachedSessionRuntime,
	ensureSession,
	reloadSystemPromptForSession,
	getSessionWorkingDir,
	getSessionModel,
	getSessionMeta,
	markSessionAsActive,
	persistRegistry,
	emitStatus,
	busySessions,
	previousWorkingDirBySession,
	getHalDir,
	sessionMetaSnapshot,
} from './sessions.ts'

export async function dropQueuedCommands(reason: string, sessionId: string): Promise<number> {
	const dropped = drainQueuedCommands(sessionId)
	for (const cmd of dropped) {
		await publishCommandPhase(cmd.id, 'failed', reason, sessionId)
	}
	return dropped.length
}

export async function handleCommand(command: RuntimeCommand, sessionId: string): Promise<void> {
	await publishCommandPhase(command.id, 'started', undefined, sessionId)

	try {
		switch (command.type) {
			case 'prompt':
				// Prompt already echoed in processCommand for immediate display
				await processPrompt(sessionId, command.text ?? '')
				void maybeAutoTopic(sessionId)
				break

			case 'handoff':
				await runHandoff(sessionId, command.text)
				break

			case 'reset':
				await runReset(sessionId)
				break

			case 'model':
				await runModel(sessionId, command.text ?? '')
				break

			case 'system':
				await runSystem(sessionId)
				break



			case 'topic':
				await runTopic(sessionId, command.text ?? '')
				break

			// 'close', 'fork', and 'cd' are handled immediately in processCommand (bypass scheduler)

			case 'restart':
				await saveSessionBeforeExit(sessionId)
				process.exit(100)

			default:
				await publishLine(`[command] unknown: ${command.type}`, 'warn', sessionId)
		}
		await publishCommandPhase(command.id, 'done', undefined, sessionId)
	} catch (e: any) {
		await publishLine(`[error] ${e.message || e}`, 'error', sessionId)
		await publishCommandPhase(command.id, 'failed', e.message, sessionId)
	}
}

export async function runFork(sessionId: string, _command: RuntimeCommand): Promise<void> {
	const busy = busySessions.has(sessionId)

	// Save current runtime state to disk before copying
	const runtime = getCachedSessionRuntime(sessionId)
	if (runtime) {
		await saveSession(sessionId, runtime.messages, runtime.tokenTotals, sessionMetaSnapshot(sessionId))
	}
	const { forkSession } = await import('../session.ts')
	const newId = await forkSession(sessionId)
	const workingDir = getSessionWorkingDir(sessionId)
	const newSession = await ensureSession(newId, workingDir, sessionId)

	// Inherit parent's per-session model
	const parentMeta = getSessionMeta(sessionId)
	if (parentMeta?.model) {
		newSession.model = parentMeta.model
		await persistRegistry()
	}

	// Record fork in conversation histories.
	// Skip the marker on the original if busy — inserting a user message
	// mid-response would corrupt the alternating user/assistant pattern.
	if (runtime && !busy) {
		runtime.messages.push({ role: 'user', content: `[forked to ${newId}]` })
	}
	const forkRuntime = await getOrLoadSessionRuntime(newId)

	// If the source session is mid-generation, snapshot the in-progress
	// content blocks so the forked session sees the partial response.
	if (busy && runtime?.streamingBlocks) {
		const blocks = runtime.streamingBlocks.filter((b: any) => {
			if (!b) return false
			if (b.type === 'thinking' && !b.signature) return false
			if (b.type === 'tool_use' && typeof b.input === 'string') return false
			if (b.type === 'text' && !b.text?.trim()) return false
			return true
		})
		if (blocks.length > 0) {
			forkRuntime.messages.push({ role: 'assistant', content: structuredClone(blocks) })
		}
	}

	forkRuntime.messages.push({ role: 'user', content: `[forked from ${sessionId}]` })

	const ts = new Date().toISOString()
	const forkEvent = { type: 'fork' as const, parent: sessionId, child: newId, ts }
	await appendConversation(sessionId, forkEvent)
	await appendConversation(newId, forkEvent)

	markSessionAsActive(newId)
	// If the parent was mid-generation, start the child paused so both
	// sessions appear active but the child waits for the user.
	if (busy) {
		forkRuntime.pausedByUser = true
		pauseSession(newId)
	}
	await persistRegistry()
	await publishLine(`[fork] forked ${sessionId} -> ${newId}`, 'meta', sessionId)
	const pauseNote = busy ? ' (paused)' : ''
	await publishLine(`[fork] forked from ${sessionId}${pauseNote}`, 'fork', newId)
	await emitStatus()
}

/** Emit an estimated context so the statusline stays up-to-date after session changes */
async function publishEstimatedContext(sessionId: string): Promise<void> {
	const runtime = await getOrLoadSessionRuntime(sessionId)
	const cal = await getTokenCalibration(getSessionModel(sessionId))
	const systemTokens = estimateTokensSync(runtime.systemBytes, cal)
	const msgTokens = runtime.messages.reduce((sum, m) => sum + estimateMessageTokens(m, cal), 0)
	const used = systemTokens + msgTokens
	await publishContext(sessionId, { used, max: MAX_CONTEXT, estimated: true })
}

/** Max chars per tool result in handoff text — full output isn't needed for summarization */
const MAX_TOOL_RESULT_CHARS = 500
/** Target max chars for the conversation text sent to the compact model */
const MAX_CONVERSATION_CHARS = 300_000
/** How many chars to keep from the start when windowing */
const WINDOW_HEAD_CHARS = 30_000

/**
 * Convert messages to a compact text representation for handoff summarization.
 * Strips thinking blocks and truncates large tool results.
 */
export function formatMessagesForHandoff(messages: any[]): string {
	return messages
		.map((m: any) => {
			const role = m.role
			const content =
				typeof m.content === 'string'
					? m.content
					: Array.isArray(m.content)
						? m.content
								.map((b: any) => {
									if (b.type === 'text') return b.text
									// Skip thinking blocks — not useful for summarization
									if (b.type === 'thinking') return ''
									if (b.type === 'tool_use')
										return `[tool: ${b.name}] ${JSON.stringify(b.input)}`
									if (b.type === 'tool_result') {
										const raw =
											typeof b.content === 'string'
												? b.content
												: JSON.stringify(b.content)
										return raw.length > MAX_TOOL_RESULT_CHARS
											? `[result] ${raw.slice(0, MAX_TOOL_RESULT_CHARS)}…`
											: `[result] ${raw}`
									}
									return ''
								})
								.filter(Boolean)
								.join('\n')
						: ''
			return `[${role}]\n${content}`
		})
		.join('\n\n---\n\n')
}

/**
 * If conversation text is too long, keep the beginning (project context)
 * and the end (recent work) with a gap marker.
 */
export function windowConversationText(text: string): string {
	if (text.length <= MAX_CONVERSATION_CHARS) return text
	const tailChars = MAX_CONVERSATION_CHARS - WINDOW_HEAD_CHARS - 200 // 200 for marker
	const head = text.slice(0, WINDOW_HEAD_CHARS)
	const tail = text.slice(-tailChars)
	const omitted = Math.round((text.length - WINDOW_HEAD_CHARS - tailChars) / 1000)
	return `${head}\n\n[... ~${omitted}K chars of conversation omitted for brevity ...]\n\n${tail}`
}

async function runHandoff(sessionId: string, text?: string): Promise<void> {
	const runtime = await getOrLoadSessionRuntime(sessionId)
	if (runtime.messages.length === 0) {
		await publishLine('[handoff] nothing to hand off — session is empty', 'warn', sessionId)
		return
	}

	await publishActivity('Generating handoff summary...', sessionId)
	await publishLine('[handoff] generating summary...', 'meta', sessionId)

	// Use compact model for handoff summary (derived from session's model)
	const sessionModel = getSessionModel(sessionId)
	const compactModel = resolveCompactModel(sessionModel)
	const provider = getProvider(providerForModel(compactModel))
	await provider.refreshAuth()

	const systemPrompt = `You are summarizing a coding session for handoff to a fresh session. Produce a concise markdown summary that captures:
1. What was being worked on (goals, context)
2. What was accomplished so far
3. Current state (what files were changed, what's working/broken)
4. What needs to be done next
5. Any important decisions or context the next session should know

IMPORTANT: Do NOT reproduce the conversation. Synthesize and summarize. Be specific about file paths, function names, and technical details. Focus especially on the MOST RECENT work — that's what the next session needs to continue.`

	const conversationText = windowConversationText(
		formatMessagesForHandoff(runtime.messages),
	)

	const userMsg = text
		? `${text}\n\n---\n\nHere is the conversation to summarize:\n\n${conversationText}`
		: `Summarize this coding session for handoff:\n\n${conversationText}`

	const { text: summary, error, truncated } = await provider.complete({
		model: modelIdForModel(compactModel),
		system: systemPrompt,
		userMessage: userMsg,
		maxTokens: 8192,
	})

	if (error) {
		await publishActivity('', sessionId)
		await publishLine(`[handoff] failed: ${error}`, 'error', sessionId)
		return
	}

	const handoffSummary = summary.trim()
	if (!handoffSummary || handoffSummary === 'No response.') {
		await publishActivity('', sessionId)
		await publishLine('[handoff] failed: summary model returned empty output', 'error', sessionId)
		return
	}

	if (truncated) {
		await publishLine('[handoff] warning: summary was truncated (output limit)', 'warn', sessionId)
	}

	await performHandoff(sessionId, handoffSummary)
	await appendConversation(sessionId, { type: 'handoff', ts: new Date().toISOString() })
	await publishActivity('', sessionId)
	await publishLine(
		'[handoff] summary saved to handoff.md, session rotated to session-previous.ason',
		'meta',
		sessionId,
	)
	await publishLine('[handoff] new session started — handoff context loaded', 'meta', sessionId)

	// Clear runtime cache so next prompt loads fresh, then publish updated context
	const { getSessionCache } = await import('./sessions.ts')
	getSessionCache().delete(sessionId)
	await publishEstimatedContext(sessionId)
}

async function runReset(sessionId: string): Promise<void> {
	// Pause if busy
	const runtime = await getOrLoadSessionRuntime(sessionId)
	if (busySessions.has(sessionId)) {
		runtime.pausedByUser = true
		runtime.activeAbort?.abort()
	}

	await clearSession(sessionId)
	const { getSessionCache } = await import('./sessions.ts')
	getSessionCache().delete(sessionId)

	const meta = getSessionMeta(sessionId)
	if (meta) {
		meta.messageCount = 0
		meta.updatedAt = new Date().toISOString()
		await persistRegistry()
	}

	await appendConversation(sessionId, { type: 'reset', ts: new Date().toISOString() })
	await publishLine('[reset] session cleared', 'meta', sessionId)
	await publishEstimatedContext(sessionId)
	await emitStatus()
}

async function runModel(sessionId: string, text: string): Promise<void> {
	const name = text.trim()
	if (!name) {
		const current = getSessionModel(sessionId)
		const meta = getSessionMeta(sessionId)
		const globalDefault = resolveModel(loadConfig().model)
		const suffix = meta?.model ? ` (global default: ${globalDefault})` : ' (global default)'
		await publishLine(`[model] current: ${current}${suffix}`, 'info', sessionId)
		const aliases = Object.entries(MODEL_ALIASES).map(([alias, full]) => {
			const marker = full === current ? ' (active)' : ''
			return `  ${alias} → ${full}${marker}`
		})
		await publishLine(`[model] available:\n${aliases.join('\n')}`, 'info', sessionId)
		return
	}

	const prevModel = getSessionModel(sessionId)
	const fullModel = resolveModel(name)

	// Set per-session model override
	const meta = getSessionMeta(sessionId)
	if (meta) {
		meta.model = fullModel
		meta.updatedAt = new Date().toISOString()
		await persistRegistry()
	}

	// Record model change in conversation history so handoff summaries capture it
	const runtime = await getOrLoadSessionRuntime(sessionId)
	runtime.messages.push({
		role: 'user',
		content: `[model changed from ${prevModel} to ${fullModel}]`,
	})

	await saveSessionInfo(sessionId, {
		...sessionMetaSnapshot(sessionId),
		updatedAt: new Date().toISOString(),
		lastPrompt: extractLastPrompt(runtime.messages),
	})

	await appendConversation(sessionId, { type: 'model', from: prevModel, to: fullModel, ts: new Date().toISOString() })

	// Reload system prompt for new model
	const loaded = await reloadSystemPromptForSession(sessionId)
	await publishLine(`[model] ${prevModel} -> ${fullModel}`, 'meta', sessionId)
	if (loaded.length > 0) {
		await publishLine(`[system] reloaded ${loaded.join(', ')} (model changed)`, 'meta', sessionId)
	}
}

export async function runSystem(sessionId: string): Promise<void> {
	const runtime = await getOrLoadSessionRuntime(sessionId)
	const blocks = runtime.systemPrompt
	if (!blocks || blocks.length === 0) {
		await publishLine('[system] (no system prompt loaded)', 'info', sessionId)
		return
	}
	const text = blocks.map((b: any) => b.text ?? '').join('\n---\n')
	const lines = text.split('\n')
	const preview = lines.slice(0, 40).join('\n')
	const suffix = lines.length > 40 ? `\n... (${lines.length - 40} more lines)` : ''
	await publishLine(
		`[system] ${blocks.length} block(s), ${runtime.systemBytes} bytes:\n${preview}${suffix}`,
		'info',
		sessionId,
	)
}

function resolveCdPath(sessionId: string, input: string, baseDir: string): string {
	const trimmed = input.trim()
	const halDir = getHalDir()
	const home = process.env.HOME ? resolve(process.env.HOME) : null
	if (!trimmed || trimmed === '.hal') return halDir
	if (trimmed === '-') {
		const prev = previousWorkingDirBySession.get(sessionId)
		if (prev) return prev
	}
	if (trimmed === '~') return home ?? baseDir
	if (trimmed.startsWith('~/') && home) return resolve(home, trimmed.slice(2))
	if (isAbsolute(trimmed)) return resolve(trimmed)
	return resolve(baseDir, trimmed)
}

export async function runCd(sessionId: string, text: string): Promise<void> {
	if (!text.trim()) {
		await publishLine(`[cd] ${getSessionWorkingDir(sessionId)}`, 'info', sessionId)
		return
	}

	const previous = getSessionWorkingDir(sessionId)
	const next = resolveCdPath(sessionId, text, previous)

	const { existsSync, statSync } = await import('fs')
	if (!existsSync(next) || !statSync(next).isDirectory()) {
		await publishLine(`[cd] not a directory: ${next}`, 'error', sessionId)
		return
	}

	if (previous !== next) previousWorkingDirBySession.set(sessionId, previous)

	const meta = getSessionMeta(sessionId)
	if (meta) {
		meta.workingDir = next
		meta.updatedAt = new Date().toISOString()
		await persistRegistry()
	}

	const runtime = await getOrLoadSessionRuntime(sessionId)
	await saveSessionInfo(sessionId, {
		...sessionMetaSnapshot(sessionId),
		updatedAt: new Date().toISOString(),
		lastPrompt: extractLastPrompt(runtime.messages),
	})

	if (previous !== next) {
		await appendConversation(sessionId, { type: 'cd', from: previous, to: next, ts: new Date().toISOString() })
	}

	const loaded = await reloadSystemPromptForSession(sessionId)
	const dirMsg = previous !== next ? `${previous} -> ${next}` : next
	await publishLine(`[cd] ${dirMsg}`, 'meta', sessionId)
	if (loaded.length > 0) {
		await publishLine(`[system] reloaded ${loaded.join(', ')} (cwd changed)`, 'meta', sessionId)
	}
	await publishEstimatedContext(sessionId)
	await emitStatus()

}

async function runTopic(sessionId: string, text: string): Promise<void> {
	const topic = text.trim()
	const meta = getSessionMeta(sessionId)
	if (!topic) {
		const current = meta?.topic || '(none)'
		await publishLine(`[topic] ${current}`, 'info', sessionId)
		return
	}

	const prev = meta?.topic
	await setSessionTopic(sessionId, topic)
	await appendConversation(sessionId, { type: 'topic', from: prev, to: topic, ts: new Date().toISOString() })
	await publishLine(`[topic] ${topic}`, 'meta', sessionId)
}

export async function setSessionTopic(sessionId: string, topic: string): Promise<void> {
	const meta = getSessionMeta(sessionId)
	if (meta) {
		meta.topic = topic
		meta.updatedAt = new Date().toISOString()
		await persistRegistry()
	}
	await emitStatus()
}

/** Extract first real user prompt text from messages (skipping internal markers). */
function extractMessageText(m: any): string {
	if (typeof m.content === 'string') return m.content
	if (Array.isArray(m.content)) return m.content.find((b: any) => b.type === 'text')?.text ?? ''
	return ''
}

/** Build a summary of the first exchange for topic generation. */
function topicContext(messages: any[]): string | null {
	let userText: string | null = null
	let assistantText: string | null = null
	for (const m of messages) {
		if (!userText && m.role === 'user') {
			const t = extractMessageText(m)
			if (t && !t.startsWith('[')) userText = t
		} else if (userText && !assistantText && m.role === 'assistant') {
			assistantText = extractMessageText(m)
		}
		if (userText && assistantText) break
	}
	if (!userText) return null
	let ctx = `User: ${userText.slice(0, 400)}`
	if (assistantText) ctx += `\n\nAssistant: ${assistantText.slice(0, 400)}`
	return ctx
}

/** Generate a topic for the conversation after the first real exchange. */
async function maybeAutoTopic(sessionId: string): Promise<void> {
	const meta = getSessionMeta(sessionId)
	if (meta?.topic) return

	const runtime = getCachedSessionRuntime(sessionId)
	if (!runtime) return

	const hasAssistant = runtime.messages.some((m) => m.role === 'assistant')
	const ctx = topicContext(runtime.messages)
	if (!ctx || !hasAssistant) return

	try {
		const sessionModel = getSessionModel(sessionId)
		const compactModel = resolveCompactModel(sessionModel)
		const provider = getProvider(providerForModel(compactModel))
		await provider.refreshAuth()

		const { text: topic, error } = await provider.complete({
			model: modelIdForModel(compactModel),
			system: 'Generate a short topic (3-6 words) for this conversation based on what the user is actually doing. Be specific and concrete. Reply with ONLY the topic, no quotes, no punctuation at the end.',
			userMessage: ctx,
			maxTokens: 30,
		})

		if (error || !topic?.trim()) return
		await setSessionTopic(sessionId, topic.trim())
		await appendConversation(sessionId, { type: 'topic', to: topic.trim(), auto: true, ts: new Date().toISOString() })
	} catch {
		// Non-critical — silently ignore
	}
}

export async function runClose(sessionId: string): Promise<void> {
	const runtime = await getOrLoadSessionRuntime(sessionId)
	if (busySessions.has(sessionId)) {
		runtime.pausedByUser = true
		runtime.activeAbort?.abort()
	}

	await saveSession(sessionId, runtime.messages, runtime.tokenTotals, sessionMetaSnapshot(sessionId))

	// Rename session dir so the ID is freed (e.g. s-default can be fresh on restart)
	if (runtime.messages.length > 0) {
		const archiveId = makeSessionId()
		try {
			await rename(sessionDir(sessionId), sessionDir(archiveId))
		} catch {}
	}

	const { getSessionCache, getRegistry, getActiveSessionId, setActiveSessionId } =
		await import('./sessions.ts')
	getSessionCache().delete(sessionId)
	previousWorkingDirBySession.delete(sessionId)

	const registry = getRegistry()
	registry.sessions = registry.sessions.filter((s) => s.id !== sessionId)
	if (registry.activeSessionId === sessionId) {
		registry.activeSessionId = registry.sessions[0]?.id ?? null
	}
	if (getActiveSessionId() === sessionId) {
		setActiveSessionId(registry.sessions[0]?.id ?? null)
	}
	await persistRegistry()
	await publishLine(`[close] session ${sessionId} closed`, 'meta', null)
	await emitStatus()
}

async function saveSessionBeforeExit(sessionId: string): Promise<void> {
	const runtime = await getOrLoadSessionRuntime(sessionId)
	await saveSession(sessionId, runtime.messages, runtime.tokenTotals, sessionMetaSnapshot(sessionId))
}
