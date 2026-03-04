import { resolve, isAbsolute } from 'path'
import type { RuntimeCommand } from '../protocol.ts'
import { saveSessionInfo, extractLastPrompt, appendToLog, rotateSession, buildRotationContext, writeAssistantEntry, getSessionInfo } from '../session.ts'
import { sessionDir } from '../state.ts'
import {
	getConfig,
	resolveModel,
	modelIdForModel,
	mergedModelAliases,
} from '../config.ts'
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
	contextWindowForModel,
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
} from './sessions.ts'
import { generateAutoTopic, isGreetingText } from './topic.ts'

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

	// Save current metadata before forking
	const runtime = getCachedSessionRuntime(sessionId)
	if (runtime) {
		const session = getSessionInfo(sessionId)
		if (session) {
			session.updatedAt = new Date().toISOString()
			session.lastPrompt = extractLastPrompt(runtime.messages)
			session.tokenTotals = runtime.tokenTotals
		}
		await saveSessionInfo(sessionId)
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

	// Record fork in message logs
	// Skip the marker on the original if busy — inserting a user message
	// mid-response would corrupt the alternating user/assistant pattern.
	if (runtime && !busy) {
		runtime.messages.push({ role: 'user', content: `[forked to ${newId}]` })
		await appendToLog(sessionId, [{ role: 'user', content: `[forked to ${newId}]`, ts: new Date().toISOString() }])
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
			const { entry } = await writeAssistantEntry(newId, blocks)
			await appendToLog(newId, [entry])
		}
	}

	forkRuntime.messages.push({ role: 'user', content: `[forked from ${sessionId}]` })
	await appendToLog(newId, [{ role: 'user', content: `[forked from ${sessionId}]`, ts: new Date().toISOString() }])

	const ts = new Date().toISOString()
	const forkEvent = { type: 'fork' as const, parent: sessionId, child: newId, ts }
	await appendToLog(sessionId, [forkEvent])
	await appendToLog(newId, [forkEvent])

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
	const ctxWindow = contextWindowForModel(modelIdForModel(getSessionModel(sessionId)))
	await publishContext(sessionId, { used, max: ctxWindow, estimated: true })
}

async function runHandoff(sessionId: string, _text?: string): Promise<void> {
	const runtime = await getOrLoadSessionRuntime(sessionId)
	if (runtime.messages.length === 0) {
		await publishLine('[handoff] nothing to hand off — session is empty', 'warn', sessionId)
		return
	}

	// Append handoff event to current log before rotating
	await appendToLog(sessionId, [{ type: 'handoff', ts: new Date().toISOString() }])

	// Build context injection from user prompts
	const context = buildRotationContext(sessionId, runtime.messages)

	// Rotate: point currentLog to a new file
	const rotN = await rotateSession(sessionId)

	// Reset runtime with context injection
	const { getSessionCache } = await import('./sessions.ts')
	getSessionCache().delete(sessionId)
	const freshRuntime = await getOrLoadSessionRuntime(sessionId)
	freshRuntime.messages = [{ role: 'user', content: context }]

	// Write context to new log
	await appendToLog(sessionId, [{ role: 'user', content: context, ts: new Date().toISOString() }])

	await publishLine(`[handoff] rotated → messages${rotN > 1 ? rotN : ''}.asonl, context injected`, 'meta', sessionId)
	await publishEstimatedContext(sessionId)
}

async function runReset(sessionId: string): Promise<void> {
	const runtime = await getOrLoadSessionRuntime(sessionId)
	if (busySessions.has(sessionId)) {
		runtime.pausedByUser = true
		runtime.activeAbort?.abort()
	}

	if (runtime.messages.length > 0) {
		await appendToLog(sessionId, [{ type: 'reset', ts: new Date().toISOString() }])
		await rotateSession(sessionId)
	}

	const { getSessionCache } = await import('./sessions.ts')
	getSessionCache().delete(sessionId)

	const meta = getSessionMeta(sessionId)
	if (meta) {
		meta.messageCount = 0
		meta.updatedAt = new Date().toISOString()
		await persistRegistry()
	}

	await publishLine('[reset] session cleared', 'meta', sessionId)
	await publishEstimatedContext(sessionId)
	await emitStatus()
}

async function runModel(sessionId: string, text: string): Promise<void> {
	const name = text.trim()
	if (!name) {
		const current = getSessionModel(sessionId)
		const meta = getSessionMeta(sessionId)
		const globalDefault = resolveModel(getConfig().defaultModel)
		const suffix = meta?.model ? ` (global default: ${globalDefault})` : ' (global default)'
		await publishLine(`[model] current: ${current}${suffix}`, 'info', sessionId)
		const aliases = Object.entries(mergedModelAliases()).map(([alias, full]) => {
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

	// Record model change in messages so handoff summaries capture it
	const runtime = await getOrLoadSessionRuntime(sessionId)
	runtime.messages.push({
		role: 'user',
		content: `[model changed from ${prevModel} to ${fullModel}]`,
	})

	const session = getSessionInfo(sessionId)
	if (session) {
		session.updatedAt = new Date().toISOString()
		session.lastPrompt = extractLastPrompt(runtime.messages)
	}
	await saveSessionInfo(sessionId)

	const ts = new Date().toISOString()
	await appendToLog(sessionId, [
		{ role: 'user', content: `[model changed from ${prevModel} to ${fullModel}]`, ts },
		{ type: 'model', from: prevModel, to: fullModel, ts },
	])

	// Reload system prompt for new model
	const loaded = await reloadSystemPromptForSession(sessionId)
	await publishLine(`[model] ${prevModel} -> ${fullModel}`, 'meta', sessionId)
	if (loaded.length > 0) {
		await publishLine(`[system] reloaded ${loaded.join(', ')} (model changed)`, 'meta', sessionId)
	}
	await publishEstimatedContext(sessionId)
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
	const cdSession = getSessionInfo(sessionId)
	if (cdSession) {
		cdSession.updatedAt = new Date().toISOString()
		cdSession.lastPrompt = extractLastPrompt(runtime.messages)
	}
	await saveSessionInfo(sessionId)

	if (previous !== next) {
		await appendToLog(sessionId, [{ type: 'cd', from: previous, to: next, ts: new Date().toISOString() }])
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
	await appendToLog(sessionId, [{ type: 'topic', from: prev, to: topic, ts: new Date().toISOString() }])
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

/** Build topic context from the latest meaningful exchange. */
function topicContext(messages: any[]): { ctx: string; userText: string } | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const userMsg = messages[i]
		if (userMsg.role !== 'user') continue
		const userText = extractMessageText(userMsg)
		if (!userText || userText.startsWith('[') || isGreetingText(userText)) continue
		let assistantText: string | null = null
		for (let j = i + 1; j < messages.length; j++) {
			if (messages[j].role !== 'assistant') continue
			const t = extractMessageText(messages[j])
			if (t) {
				assistantText = t
				break
			}
		}
		let ctx = `User: ${userText.slice(0, 400)}`
		if (assistantText) ctx += `\n\nAssistant: ${assistantText.slice(0, 400)}`
		return { ctx, userText }
	}
	return null
}

/** Generate a topic for the conversation after the first real exchange. */
async function maybeAutoTopic(sessionId: string): Promise<void> {
	const meta = getSessionMeta(sessionId)
	if (meta?.topic) return

	const runtime = getCachedSessionRuntime(sessionId)
	if (!runtime) return

	const hasAssistant = runtime.messages.some((m) => m.role === 'assistant')
	const context = topicContext(runtime.messages)
	if (!context || !hasAssistant) return

	try {
		const sessionModel = getSessionModel(sessionId)
		const topic = await generateAutoTopic({
			sessionModel,
			ctx: context.ctx,
			firstUserText: context.userText,
		})
		if (!topic) return
		await setSessionTopic(sessionId, topic)
		await appendToLog(sessionId, [{ type: 'topic', to: topic, auto: true, ts: new Date().toISOString() }])
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

	const closeSession = getSessionInfo(sessionId)
	if (closeSession) {
		closeSession.updatedAt = new Date().toISOString()
		closeSession.lastPrompt = extractLastPrompt(runtime.messages)
		closeSession.tokenTotals = runtime.tokenTotals
	}
	await saveSessionInfo(sessionId)

	const { getSessionCache, getRegistry, getActiveSessionId, setActiveSessionId } =
		await import('./sessions.ts')
	const { sessionInfoMap } = await import('../session.ts')
	getSessionCache().delete(sessionId)
	sessionInfoMap.delete(sessionId)
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
	const session = getSessionInfo(sessionId)
	if (session) {
		session.updatedAt = new Date().toISOString()
		session.lastPrompt = extractLastPrompt(runtime.messages)
		session.tokenTotals = runtime.tokenTotals
	}
	await saveSessionInfo(sessionId)
}
