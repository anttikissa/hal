// Server runtime — watches commands and dispatches to agent loop.
//
// Broadcasts session list via IPC. Does NOT broadcast history —
// clients load that directly from disk.
//
// Command flow:
//   1. Client appends command to IPC commands file
//   2. Runtime tails commands, dispatches based on type
//   3. "prompt" commands are checked for slash commands first
//   4. Non-command prompts are forwarded to the agent loop
//   5. Agent loop streams responses back via IPC events

import { appendFileSync } from 'fs'
import { ipc } from '../ipc.ts'
import { protocol } from '../protocol.ts'
import { models } from '../models.ts'
import { sessions as sessionStore } from './sessions.ts'
import { commands } from '../runtime/commands.ts'
import type { SessionState } from '../runtime/commands.ts'
import type { SpawnMode } from '../protocol.ts'
import { agentLoop, type AgentLoopResult } from '../runtime/agent-loop.ts'
import { context } from '../runtime/context.ts'
import { apiMessages } from '../session/api-messages.ts'
import { attachments } from '../session/attachments.ts'
import { sessionIds } from '../session/ids.ts'
import { replay } from '../session/replay.ts'
import { openaiUsage } from '../openai-usage.ts'
import { ason } from '../utils/ason.ts'

import { toolRegistry } from '../tools/tool.ts'
// ── Session state ──

interface Session {
	id: string
	name?: string
	model?: string
	cwd: string
	createdAt: string
}

let activeSessions: Session[] = []
let activeRuntimePid: number | null = null
let stopPromptWatch: (() => void) | null = null

const USER_PAUSED_TEXT = '[paused]'
const RESTARTED_TEXT = '[restarted]'
const TAB_CLOSED_TEXT = 'Tab closed'
const COMMAND_PUMP_DEBUG_LOG = '/tmp/hal-command-pump.asonl'

function logCommandPump(stage: string, details: Record<string, unknown>): void {
	// Temporary instrumentation for a stalled command-reader bug. Write to /tmp
	// so we can inspect the host's internal routing without polluting session
	// history or the shared IPC logs.
	try {
		appendFileSync(COMMAND_PUMP_DEBUG_LOG, ason.stringify({
			ts: new Date().toISOString(),
			pid: process.pid,
			stage,
			...details,
		}, 'short') + '\n')
	} catch {}
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err)
}

interface SpawnSpec {
	task: string
	mode: SpawnMode
	model?: string
	cwd?: string
	title?: string
	closeWhenDone?: boolean
	sessionId?: string
}

function shouldCloseSessionAfterGeneration(
	meta: { closeWhenDone?: boolean } | null | undefined,
	result: AgentLoopResult,
): boolean {
	// Auto-close is only for a clean model-driven finish. Manual pauses,
	// provider failures, and max-iteration stops must leave the tab open.
	return !!meta?.closeWhenDone && result === 'completed'
}

function shouldAutoContinue(entries: Array<{ type: string; text?: string; ts?: string }>, now = Date.now()): boolean {
	let lastType: string | undefined
	let lastTs: string | undefined
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!
		if (entry.type === 'info' && (entry.text === USER_PAUSED_TEXT || entry.text === TAB_CLOSED_TEXT)) return false
		if (!lastType && (entry.type === 'user' || entry.type === 'tool_result' || entry.type === 'assistant')) {
			lastType = entry.type
			lastTs = entry.ts
		}
		if (lastType) break
	}
	if (lastType !== 'user' && lastType !== 'tool_result') return false
	return !lastTs || (now - new Date(lastTs).getTime()) <= 30_000
}

function sessionLabel(session: Session): string {
	return `${session.name ?? session.id} (${session.id})`
}

function recordOpenedTab(session: Session, opener?: Session): void {
	const text = opener
		? `User opened a new tab: ${sessionLabel(session)}. Opened from ${sessionLabel(opener)}.`
		: `User opened a new tab: ${sessionLabel(session)}.`
	sessionStore.appendHistorySync(session.id, [{ type: 'info', text, ts: session.createdAt }])
}

function recordForkedTab(child: Session, parent: Session): void {
	const text = `User forked ${sessionLabel(parent)} into ${sessionLabel(child)}.`
	sessionStore.appendHistorySync(child.id, [{ type: 'info', text, ts: child.createdAt }])
}


function createSession(opener?: Session, afterId?: string, sessionId = sessionIds.reserve()): Session {
	const session: Session = {
		id: sessionId,
		name: undefined,
		cwd: process.cwd(),
		createdAt: new Date().toISOString(),
	}
	insertSessionAfter(session, afterId)

	// sessionStore.createSession() is declared async for API symmetry, but the
	// actual work here is synchronous: it creates the live meta object and writes
	// session.ason right away. Publish the new tab in the same tick so the first
	// client paint already knows about it.
	void sessionStore.createSession(session.id, {
		id: session.id,
		workingDir: session.cwd,
		createdAt: session.createdAt,
		name: undefined,
		topic: undefined,
	})
	recordOpenedTab(session, opener)
	return session
}

function insertSessionAfter(session: Session, afterId?: string): void {
	if (!afterId) {
		activeSessions.push(session)
		return
	}
	const idx = activeSessions.findIndex((item) => item.id === afterId)
	if (idx < 0) {
		activeSessions.push(session)
		return
	}
	activeSessions.splice(idx + 1, 0, session)
}

function moveSessionToIndex(sessionId: string, targetIndex: number): boolean {
	const fromIndex = activeSessions.findIndex((session) => session.id === sessionId)
	if (fromIndex < 0) return false
	const clampedIndex = Math.max(0, Math.min(activeSessions.length - 1, targetIndex))
	if (fromIndex === clampedIndex) return false
	const [session] = activeSessions.splice(fromIndex, 1)
	if (!session) return false
	activeSessions.splice(clampedIndex, 0, session)
	return true
}

async function createForkSession(sourceId: string, newId = sessionIds.reserve()): Promise<Session> {
	await sessionStore.forkSession(sourceId, newId)
	const meta = sessionStore.loadSessionMeta(newId)
	const session = sessionFromMeta(meta)
	if (!session) throw new Error(`Failed to create fork session ${newId}`)
	const parent = findSession(sourceId)
	if (parent) recordForkedTab(session, parent)
	insertSessionAfter(session, sourceId)
	return session
}

function buildSpawnPrompt(parentId: string, task: string, closeWhenDone: boolean): string {
	const closeLine = closeWhenDone
		? 'After sending the handoff, finish normally and Hal will close this tab for you.'
		: 'After sending the handoff, stay open so the user can inspect the tab.'
	return [
		`You are a subagent working for parent session ${parentId}.`,
		'',
		'Task:',
		task,
		'',
		`When finished, send a concise handoff to session ${parentId} using the send tool. Include summary, files changed, and open questions.`,
		closeLine,
	].join('\n')
}

function queuePromptCommand(sessionId: string, text: string, source?: string): void {
	const createdAt = new Date().toISOString()
	logCommandPump('queue-prompt', {
		sessionId,
		source,
		createdAt,
		textPreview: text.slice(0, 120),
		textLength: text.length,
	})
	ipc.appendCommand({ type: 'prompt', sessionId, text, source, createdAt })
}

async function spawnSession(parent: Session, spec: SpawnSpec): Promise<Session> {
	const mode = spec.mode === 'fresh' ? 'fresh' : 'fork'
	const child = mode === 'fork'
		? await createForkSession(parent.id, spec.sessionId)
		: createSession(undefined, parent.id, spec.sessionId)
	child.cwd = spec.cwd || (mode === 'fork' ? child.cwd : parent.cwd)
	child.model = spec.model || (mode === 'fork' ? child.model : parent.model)
	child.name = spec.title || child.name
	const topic = spec.title || child.name
	await sessionStore.updateMeta(child.id, {
		workingDir: child.cwd,
		model: child.model,
		name: child.name,
		topic,
		closeWhenDone: !!spec.closeWhenDone,
		parentSessionId: parent.id,
	})
	if (spec.closeWhenDone) {
		sessionStore.appendHistorySync(child.id, [{
			type: 'info',
			text: 'This subagent will close itself after sending a handoff.',
			ts: new Date().toISOString(),
		}])
	}
	return child
}

async function startSpawnedSession(parent: Session, child: Session, spec: SpawnSpec): Promise<void> {
	const prompt = buildSpawnPrompt(parent.id, spec.task, !!spec.closeWhenDone)
	logCommandPump('dispatch-spawn-prompt', {
		sessionId: child.id,
		source: parent.id,
		textPreview: prompt.slice(0, 120),
		textLength: prompt.length,
	})
	// This prompt originates inside the host runtime, not from another process.
	// Dispatch it directly instead of round-tripping through commands.asonl,
	// which can stall and leave brand-new subagent tabs looking dead.
	await dispatchPromptCommand(child, prompt, parent.id)
}

function findSession(sessionId: string): Session | undefined {
	return activeSessions.find((s) => s.id === sessionId)
}

function sessionFromMeta(meta: ReturnType<typeof sessionStore.loadSessionMeta>): Session | null {
	if (!meta) return null
	const dirName = meta.workingDir?.split('/').pop()
	return {
		id: meta.id,
		name: meta.topic || dirName || meta.id,
		model: meta.model,
		cwd: meta.workingDir ?? process.cwd(),
		createdAt: meta.createdAt,
	}
}

function pickMostRecentlyClosedSessionId(
	metas: Array<{ id: string; createdAt: string; closedAt?: string }>,
	openIds: Set<string>,
): string | null {
	const closed = metas
		.filter((meta) => !openIds.has(meta.id))
		.sort((a, b) => (b.closedAt ?? b.createdAt).localeCompare(a.closedAt ?? a.createdAt))
	return closed[0]?.id ?? null
}

function mostRecentlyClosedSessionId(): string | null {
	return pickMostRecentlyClosedSessionId(
		sessionStore.loadAllSessionMetas(),
		new Set(activeSessions.map((session) => session.id)),
	)
}

function resolveResumeTarget(
	metas: Array<{ id: string; createdAt: string; closedAt?: string; name?: string }>,
	openIds: Set<string>,
	query?: string,
): string | null {
	const trimmed = query?.trim()
	if (!trimmed) return pickMostRecentlyClosedSessionId(metas, openIds)
	const exactId = metas.find((meta) => !openIds.has(meta.id) && meta.id === trimmed)
	if (exactId) return exactId.id
	const normalized = trimmed.toLowerCase()
	const exactName = metas.find((meta) => !openIds.has(meta.id) && meta.name?.trim().toLowerCase() === normalized)
	return exactName?.id ?? null
}

function syncSharedState(): void {
	ipc.updateState((state) => {
		state.sessions = activeSessions.map((s) => s.id)
		state.openSessions = activeSessions.map((s) => ({
			id: s.id,
			name: s.name,
			cwd: s.cwd,
			model: s.model,
		}))
		const openIds = new Set(state.sessions)
		for (const sessionId of Object.keys(state.busy)) {
			if (!openIds.has(sessionId)) delete state.busy[sessionId]
		}
		for (const sessionId of Object.keys(state.activity)) {
			if (!openIds.has(sessionId)) delete state.activity[sessionId]
		}
	})
}

// ── IPC helpers ──

function broadcastSessions(): void {
	syncSharedState()
	restartPromptWatch()
}

function emitInfo(sessionId: string, text: string, level: 'info' | 'error' = 'info'): void {
	ipc.appendEvent({
		id: protocol.eventId(),
		type: 'info',
		text,
		level,
		sessionId,
		createdAt: new Date().toISOString(),
	})
}

function recordTabClosed(sessionId: string): void {
	if (!agentLoop.abort(sessionId, TAB_CLOSED_TEXT)) emitInfo(sessionId, TAB_CLOSED_TEXT)
}

function restartPromptWatch(): void {
	stopPromptWatch?.()
	stopPromptWatch = context.watchPromptFiles(
		activeSessions.map((session) => ({ sessionId: session.id, cwd: session.cwd })),
		(change) => {
			emitInfo(change.sessionId, `[system reload] ${change.name} changed: ${change.path}`)
		},
	)
}

function persistCommandRetryInput(sessionId: string, text: string, result: Awaited<ReturnType<typeof commands.executeCommand>>): void {
	// Persist failed slash commands for up-arrow recall after reload. These are
	// stored as non-message history entries so they do not appear in the visible
	// conversation or get sent back to the model.
	if (!result.handled || !result.error) return
	sessionStore.appendHistorySync(sessionId, [{ type: 'input_history', text, ts: new Date().toISOString() }])
}

// ── Prompt handling ──

/** Process a prompt: check for slash commands, then forward to agent loop.
 *  label is 'steering' when the user typed during active generation. */
async function handlePrompt(session: Session, text: string, label?: 'steering', source?: string): Promise<void> {
	// Self-fencing: if leadership moved to another PID, this process must not
	// emit prompts or start generations. The real host will handle the command.
	if (!ipc.ownsHostLock()) return
	logCommandPump('handle-prompt', {
		sessionId: session.id,
		label,
		source,
		textPreview: text.slice(0, 120),
		textLength: text.length,
	})

	// Build a SessionState for the commands module
	const sessionState: SessionState = {
		id: session.id,
		name: session.name ?? '',
		model: session.model,
		cwd: session.cwd,
		createdAt: session.createdAt,
		sessions: activeSessions.map((item) => ({ id: item.id, name: item.name ?? item.id })),
	}

	// Slash commands are internal runtime commands. Handle them before emitting a
	// prompt event so they don't show up as user/steering messages in history.
	const cmdResult = await commands.executeCommand(text, sessionState, (msg, level) =>
		emitInfo(session.id, msg, level),
	)

	if (cmdResult.handled) {
		persistCommandRetryInput(session.id, text, cmdResult)
		// Sync any mutations back to session (e.g. /model, /cd, /rename)
		const cwdChanged = session.cwd !== sessionState.cwd
		const modelChanged = session.model !== sessionState.model
		const nameChanged = (session.name ?? '') !== (sessionState.name || '')
		session.model = sessionState.model
		session.cwd = sessionState.cwd
		session.name = sessionState.name || undefined

		// Persist changed metadata to disk and notify clients
		if (cwdChanged || modelChanged || nameChanged) {
			void sessionStore.updateMeta(session.id, {
				workingDir: session.cwd,
				model: session.model,
				name: session.name,
			})
			broadcastSessions()
		}

		if (cmdResult.output) emitInfo(session.id, cmdResult.output)
		if (cmdResult.error) emitInfo(session.id, cmdResult.error, 'error')
		if (label === 'steering' && !cmdResult.error && /^\/model\b/.test(text.trimStart())) {
			// Model switches during a rate-limit wait should immediately retry the
			// pending turn on the newly selected provider.
			void runGeneration(session, '', source)
		}
		return
	}

	// Emit the prompt event so clients see what was typed.
	// Inbox messages carry their source session so the target tab can show where they came from.
	ipc.appendEvent({
		type: 'prompt',
		text,
		label,
		source,
		sessionId: session.id,
		createdAt: new Date().toISOString(),
	})

	// Not a command — forward to the agent loop
	await runGeneration(session, text, source)
}

async function dispatchPromptCommand(session: Session, text: string, source?: string): Promise<void> {
	const steering = agentLoop.isActive(session.id)
	if (steering) {
		agentLoop.abort(session.id)
		// Brief yield so the abort propagates before we start a new generation.
		await Bun.sleep(50)
	}
	await handlePrompt(session, text, steering ? 'steering' : undefined, source)
}

/** Start a generation (agent loop call) for a session.
 *  If text is empty, this is a continuation (restart after crash) — don't save
 *  a new user prompt, just rebuild messages from existing history. */
async function runGeneration(session: Session, text: string, source?: string): Promise<void> {
	// Double-check ownership right before we touch history or the model API.
	// This closes the window where an old host is still alive but has already
	// been replaced by a new lock holder.
	if (!ipc.ownsHostLock()) return

	const model = session.model ?? models.defaultModel()

	// Build system prompt
	const promptResult = context.buildSystemPrompt({
		model,
		cwd: session.cwd,
		sessionId: session.id,
	})

	// Resolve [file.png] / [file.txt] attachment references in user text.
	// Images get base64-encoded and stored as blobs; history saves lightweight
	// user parts with blob refs so the ASONL file stays small.
	if (text) {
		const resolved = await attachments.resolve(session.id, text)
		await sessionStore.appendHistory(session.id, [
			{
				type: 'user',
				parts: resolved.logParts,
				source,
				ts: new Date().toISOString(),
			},
		])
	}

	// Load conversation history and convert to provider messages
	const messages = apiMessages.toProviderMessages(session.id)

	// Emit stream-start so clients know generation is happening
	ipc.appendEvent({
		type: 'stream-start',
		sessionId: session.id,
		createdAt: new Date().toISOString(),
	})

	let result: AgentLoopResult = 'failed'
	try {
		result = await agentLoop.runAgentLoop({
			sessionId: session.id,
			model,
			cwd: session.cwd,
			systemPrompt: promptResult.text,
			messages,
			onStatus: async (busy, activity) => {
				ipc.updateState((state) => {
					if (busy) state.busy[session.id] = true
					else delete state.busy[session.id]
					if (activity) state.activity[session.id] = activity
					else delete state.activity[session.id]
				})
			},
		})
	} catch (err: any) {
		emitInfo(session.id, `Generation failed: ${err?.message ?? String(err)}`, 'error')
	}
	const meta = sessionStore.loadSessionMeta(session.id)
	if (shouldCloseSessionAfterGeneration(meta, result) && !agentLoop.isActive(session.id)) {
		await sessionStore.updateMeta(session.id, { closedAt: new Date().toISOString(), closeWhenDone: false })
		sessionStore.deactivateSession(session.id)
		activeSessions = activeSessions.filter((s) => s.id !== session.id)
		broadcastSessions()
	}
}

// ── Reset / compaction context refresh ───────────────────────────────────────

function publishContextEstimate(session: Session): void {
	const model = session.model ?? models.defaultModel()
	const promptResult = context.buildSystemPrompt({
		model,
		cwd: session.cwd,
		sessionId: session.id,
	})
	const overheadBytes = promptResult.text.length + JSON.stringify(toolRegistry.toToolDefs()).length
	const messages = apiMessages.toProviderMessages(session.id)
	const est = context.estimateContext(messages, model, overheadBytes)
	void sessionStore.updateMeta(session.id, { context: { used: est.used, max: est.max } })
}

async function runReset(session: Session): Promise<void> {
	if (!ipc.ownsHostLock()) return
	if (agentLoop.isActive(session.id)) {
		emitInfo(session.id, 'Session is busy')
		return
	}

	const entries = sessionStore.loadHistory(session.id)
	const oldLog = sessionStore.loadSessionMeta(session.id)?.currentLog ?? 'history.asonl'
	await sessionStore.rotateLog(session.id)
	const forkEntry = entries[0]?.type === 'forked_from' ? [entries[0]] : []
	const ts = new Date().toISOString()
	await sessionStore.appendHistory(session.id, [
		...forkEntry,
		{ type: 'reset', ts },
		{ type: 'user', parts: [{ type: 'text', text: `[system] Session was reset. Previous conversation: ${oldLog}` }], ts },
	])
	publishContextEstimate(session)
	emitInfo(session.id, 'Conversation cleared.')
}
// ── Compaction ──

async function runCompact(session: Session): Promise<void> {
	if (!ipc.ownsHostLock()) return
	if (agentLoop.isActive(session.id)) {
		emitInfo(session.id, 'Session is busy')
		return
	}

	const entries = sessionStore.loadHistory(session.id)
	const userMsgs = entries.filter((entry) => entry.type === 'user')
	if (userMsgs.length === 0) {
		emitInfo(session.id, 'Nothing to compact')
		return
	}

	const contextText = replay.buildCompactionContext(session.id, entries)
	const oldLog = sessionStore.loadSessionMeta(session.id)?.currentLog ?? 'history.asonl'
	const newLog = await sessionStore.rotateLog(session.id)
	const forkEntry = entries[0]?.type === 'forked_from' ? [entries[0]] : []
	const ts = new Date().toISOString()

	await sessionStore.appendHistory(session.id, [
		...forkEntry,
		{ type: 'compact', ts },
		{ type: 'user', parts: [{ type: 'text', text: `[system] Session was manually compacted. Previous conversation: ${oldLog}` }], ts },
		{ type: 'user', parts: [{ type: 'text', text: contextText }], ts },
	])

	publishContextEstimate(session)
	emitInfo(session.id, `Context compacted (${userMsgs.length} user messages summarized, now writing to ${newLog})`)
}

// ── Command dispatch ──
//
// CRITICAL: handleCommand must NEVER await long-running operations like
// agent loop generation. The command tail loop calls handleCommand for
// every incoming command. If we block here, all subsequent commands
// (abort, new prompts, tab operations) are stuck until generation finishes.
// Generation is fire-and-forget; the agent loop communicates results via IPC events.

async function handleCommand(cmd: any, signal: AbortSignal): Promise<void> {
	const sessionId = cmd.sessionId
	const session = sessionId ? findSession(sessionId) : activeSessions[0]

		switch (cmd.type) {
			case 'prompt': {
				if (!session) return
				const source = typeof cmd.source === 'string' ? cmd.source : undefined
				// Fire-and-forget: don't block the command loop on generation.
				void dispatchPromptCommand(session, cmd.text ?? '', source)
				break
			}


		case 'continue': {
			if (!session) return
			if (agentLoop.isActive(session.id)) return
			void runGeneration(session, '')
			break
		}

		case 'abort': {
			if (!sessionId) return
			const aborted = agentLoop.abort(sessionId)
			if (!aborted) emitInfo(sessionId, 'No active generation to abort')
			break
		}

		case 'reset': {
			if (!session) return
			await runReset(session)
			break
		}

		case 'compact': {
			if (!session) return
			await runCompact(session)
			break
		}

		case 'open': {
			if (typeof cmd.text === 'string' && cmd.text.startsWith('fork:')) {
				const parentId = cmd.text.slice(5)
				const child = await createForkSession(parentId)
				const msg = `forked ${parentId} → ${child.id}`
				emitInfo(parentId, msg)
				emitInfo(child.id, msg)
			} else if (typeof cmd.text === 'string' && cmd.text.startsWith('after:')) {
				const afterId = cmd.text.slice(6)
				createSession(session, afterId)
			} else {
				createSession(session)
			}
			broadcastSessions()
			break
		}

		case 'spawn': {
			if (!session) return
			const raw = typeof cmd.text === 'string' ? cmd.text : ''
			const parsed = ason.parse(raw || '{}') as Partial<SpawnSpec>
			if (!parsed.task || typeof parsed.task !== 'string') {
				emitInfo(session.id, 'Spawn task is required', 'error')
				break
			}
			const spec: SpawnSpec = {
				task: parsed.task,
				mode: parsed.mode === 'fresh' ? 'fresh' : 'fork',
				model: parsed.model,
				cwd: parsed.cwd,
				title: parsed.title,
				closeWhenDone: !!parsed.closeWhenDone,
				sessionId: typeof parsed.sessionId === 'string' && parsed.sessionId.trim() ? parsed.sessionId.trim() : undefined,
			}
			const child = await spawnSession(session, spec)
			broadcastSessions()
			void startSpawnedSession(session, child, spec)
			break
		}

		case 'resume': {
			const selector = String(cmd.text ?? '').trim()
			const resumeId = resolveResumeTarget(
				sessionStore.loadAllSessionMetas(),
				new Set(activeSessions.map((s) => s.id)),
				selector,
			)
			if (!resumeId) {
				emitInfo(sessionId ?? activeSessions[0]?.id ?? '', selector ? 'No matching closed session.' : 'No closed sessions.', selector ? 'error' : 'info')
				break
			}
			if (activeSessions.some((s) => s.id === resumeId)) {
				emitInfo(sessionId ?? activeSessions[0]?.id ?? resumeId, `Session ${resumeId} is already open`)
				break
			}
			const meta = sessionStore.activateSession(resumeId)
			const resumed = sessionFromMeta(meta)
			if (!resumed) {
				emitInfo(sessionId ?? activeSessions[0]?.id ?? resumeId, `Session ${resumeId} not found`, 'error')
				break
			}
			activeSessions.push(resumed)
			await sessionStore.updateMeta(resumeId, { closedAt: undefined })
			broadcastSessions()
			break
		}

		case 'move': {
			if (!sessionId) return
			const targetPos = parseInt(String(cmd.text ?? ''), 10)
			if (!Number.isFinite(targetPos)) return
			if (moveSessionToIndex(sessionId, targetPos - 1)) broadcastSessions()
			break
		}

		case 'close': {
			if (!sessionId) return
			// Record the user-visible close notice whether or not generation was active.
			recordTabClosed(sessionId)
			await sessionStore.updateMeta(sessionId, { closedAt: new Date().toISOString() })
			sessionStore.deactivateSession(sessionId)
			activeSessions = activeSessions.filter((s) => s.id !== sessionId)
			if (activeSessions.length === 0) await createSession()
			broadcastSessions()
			break
		}
		}
	}

// ── Main entry point ──

function startRuntime(signal: AbortSignal): void {
	activeRuntimePid = process.pid; activeSessions = []; stopPromptWatch?.(); stopPromptWatch = null; sessionStore.deactivateAllSessions()

	// Load session metadata only (no history — clients load that themselves).
	const metas = sessionStore.loadSessionMetas()

	if (metas.length > 0) {
		for (const meta of metas) {
			activeSessions.push({
				id: meta.id,
				name: meta.name,
				model: meta.model,
				cwd: meta.workingDir ?? process.cwd(),
				createdAt: meta.createdAt,
			})
		}
	} else {
		// First run — create and persist the initial tab, then publish it before the
		// client's first steady-state redraw. This avoids a brief "no tabs" frame.
		createSession()
		if (!signal.aborted && activeRuntimePid === process.pid) broadcastSessions()
	}

	restartPromptWatch()
	signal.addEventListener('abort', () => {
		stopPromptWatch?.()
		stopPromptWatch = null
		const ts = new Date().toISOString()
		for (const session of activeSessions) {
			if (!agentLoop.isActive(session.id)) continue
			sessionStore.appendHistorySync(session.id, [{ type: 'info', text: RESTARTED_TEXT, ts }])
			agentLoop.abort(session.id, '')
		}
	}, { once: true })

	ipc.updateState((state) => {
		state.busy = {}
		state.activity = {}
	})
	if (metas.length > 0) syncSharedState()

	// Refresh models.dev context window cache (fire-and-forget)
	models.refreshModels().catch((err) => {
		console.error(`[models] refresh failed: ${errorMessage(err)}`)
	})
	openaiUsage.start(signal)

	// Restored sessions can be published right away. On first run, createSession()
	// publishes after it finishes persisting the new tab.
	if (metas.length > 0) {
		setTimeout(() => {
			if (signal.aborted || activeRuntimePid !== process.pid) return
			broadcastSessions()
		}, 0)
	}

	// Deferred: resolve interrupted tools and auto-continue pending sessions.
	// This runs after the initial broadcast so clients see tabs immediately,
	// then we fix up history and restart any in-progress generations.
	void (async () => {
		for (const session of activeSessions) {
			if (signal.aborted || activeRuntimePid !== process.pid || !ipc.ownsHostLock()) return
			const entries = sessionStore.loadAllHistory(session.id)
			if (entries.length === 0) continue

			// 1. Find tool calls that never got results (interrupted mid-execution).
			//    Write placeholder [interrupted] results so the conversation is valid.
			const interrupted = sessionStore.detectInterruptedTools(entries)
			if (interrupted.length > 0) {
				const toolNames = interrupted.map((t) => t.name).join(', ')
				emitInfo(session.id, `Resolving ${interrupted.length} interrupted tool(s): ${toolNames}`)
				for (const t of interrupted) {
					await sessionStore.appendHistory(session.id, [{
						type: 'tool_result',
						toolId: t.id,
						output: '[interrupted]',
						ts: new Date().toISOString(),
					}])
				}
			}

			// 2. Check if the session has a pending turn (user sent prompt or
			//    tool results were written, but model never responded). If so,
			//    and the turn is recent (<30s), auto-continue generation.
			const allEntries = interrupted.length > 0
				? sessionStore.loadAllHistory(session.id) // re-read with new tool_results
				: entries
			if (shouldAutoContinue(allEntries)) {
				emitInfo(session.id, 'Continuing...')
				void runGeneration(session, '') // empty text = continue existing conversation
			}
		}
	})()

	// Tail commands and dispatch
	void (async () => {
		for await (const cmd of ipc.tailCommands(signal)) {
			logCommandPump('loop-received', {
				cmdType: cmd?.type,
				sessionId: cmd?.sessionId,
				source: cmd?.source,
				createdAt: cmd?.createdAt,
				textPreview: typeof cmd?.text === 'string' ? cmd.text.slice(0, 120) : undefined,
				activeSessions: activeSessions.map((session) => session.id),
			})
			if (signal.aborted || activeRuntimePid !== process.pid) {
				logCommandPump('loop-break-abort', { activeRuntimePid, signalAborted: signal.aborted })
				break
			}
			// Self-fencing: the old host must stop reading shared commands as soon
			// as leadership moves to another PID.
			if (!ipc.ownsHostLock()) {
				logCommandPump('loop-break-host-lock', {})
				break
			}
			// Most commands target a live session. But tab-management commands can
			// legitimately arrive with a stale sessionId during the brief window after
			// Ctrl-W, before the client has processed the sessions update and switched
			// its active tab locally.
			const hasLiveSession = !cmd.sessionId || activeSessions.some((session) => session.id === cmd.sessionId)
			if (!hasLiveSession && cmd.type !== 'open' && cmd.type !== 'resume') {
				logCommandPump('loop-skip-no-session', {
					cmdType: cmd?.type,
					sessionId: cmd?.sessionId,
					activeSessions: activeSessions.map((session) => session.id),
				})
				continue
			}
			try {
				logCommandPump('handle-command-start', {
					cmdType: cmd?.type,
					sessionId: cmd?.sessionId,
				})
				await handleCommand(cmd, signal)
				logCommandPump('handle-command-done', {
					cmdType: cmd?.type,
					sessionId: cmd?.sessionId,
				})
			} catch (err: any) {
				logCommandPump('handle-command-error', {
					cmdType: cmd?.type,
					sessionId: cmd?.sessionId,
					error: err?.message ?? String(err),
				})
				// Don't let a single command crash the runtime
				const sid = cmd.sessionId ?? activeSessions[0]?.id
				if (sid) emitInfo(sid, `Command error: ${err?.message ?? String(err)}`, 'error')
			}
		}
	})()

	// Initialize MCP servers (external tool servers from mcp.ason).
	// Non-blocking — failures are logged but don't prevent startup.
	void import('../mcp/client.ts')
		.then(({ mcp }) => {
			mcp.initServers().catch((err: any) => {
				console.error(`[mcp] init failed: ${err?.message ?? String(err)}`)
			})
			// Clean up MCP servers on shutdown
			signal.addEventListener(
				'abort',
				() => {
					void mcp.shutdown()
				},
				{ once: true },
			)
		})
		.catch((err) => {
			console.error(`[mcp] failed to load client module: ${errorMessage(err)}`)
		})

	// Start inbox watcher (external messages)
	void import('../runtime/inbox.ts')
		.then(({ inbox }) => {
			inbox.startWatching(signal, (sessionId, text, source) => {
				if (!findSession(sessionId)) return
				queuePromptCommand(sessionId, text, source)
			})
		})
		.catch((err) => {
			console.error(`[inbox] failed to load module: ${errorMessage(err)}`)
		})
}

export const runtime = { startRuntime, pickMostRecentlyClosedSessionId, resolveResumeTarget, shouldAutoContinue, shouldCloseSessionAfterGeneration, recordTabClosed, spawnSessionForTests: spawnSession, startSpawnedSessionForTests: startSpawnedSession }
