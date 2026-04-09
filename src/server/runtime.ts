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

import { ipc } from '../ipc.ts'
import { protocol } from '../protocol.ts'
import { models } from '../models.ts'
import { sessions as sessionStore } from './sessions.ts'
import { commands } from '../runtime/commands.ts'
import type { SessionState } from '../runtime/commands.ts'
import { agentLoop } from '../runtime/agent-loop.ts'
import { context } from '../runtime/context.ts'
import { apiMessages } from '../session/api-messages.ts'
import { attachments } from '../session/attachments.ts'
import { replay } from '../session/replay.ts'

// ── Session state ──

interface Session {
	id: string
	name: string
	model?: string
	cwd: string
	createdAt: string
}

let activeSessions: Session[] = []
let activeRuntimePid: number | null = null

function makeSessionId(): string {
	const month = String(new Date().getMonth() + 1).padStart(2, '0')
	const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
	let suffix = ''
	for (let i = 0; i < 3; i++) suffix += chars[Math.floor(Math.random() * chars.length)]
	return `${month}-${suffix}`
}

async function createSession(): Promise<Session> {
	const session: Session = {
		id: makeSessionId(),
		name: `tab ${activeSessions.length + 1}`,
		cwd: process.cwd(),
		createdAt: new Date().toISOString(),
	}
	activeSessions.push(session)

	// Persist the session itself. The shared session list is updated when we
	// broadcast, so state.ason has a single writer.
	await sessionStore.createSession(session.id, {
		id: session.id,
		workingDir: session.cwd,
		createdAt: session.createdAt,
		topic: undefined,
	})
	return session
}

async function createForkSession(sourceId: string): Promise<Session> {
	const newId = makeSessionId()
	await sessionStore.forkSession(sourceId, newId)
	const meta = sessionStore.loadSessionMeta(newId)
	const session = sessionFromMeta(meta)
	if (!session) throw new Error(`Failed to create fork session ${newId}`)
	activeSessions.push(session)
	return session
}

function findSession(sessionId: string): Session | undefined {
	return activeSessions.find((s) => s.id === sessionId)
}

function sessionFromMeta(meta: ReturnType<typeof sessionStore.loadSessionMeta>): Session | null {
	if (!meta) return null
	const dirName = meta.workingDir?.split('/').pop()
	return {
		id: meta.id,
		name: meta.topic ?? dirName ?? `tab ${activeSessions.length + 1}`,
		model: meta.model,
		cwd: meta.workingDir ?? process.cwd(),
		createdAt: meta.createdAt,
	}
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
	ipc.appendEvent({
		type: 'sessions',
		sessions: activeSessions.map((s) => ({
			id: s.id,
			name: s.name,
			cwd: s.cwd,
			model: s.model,
		})),
	})
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

// ── Prompt handling ──

/** Process a prompt: check for slash commands, then forward to agent loop.
 *  label is 'steering' when the user typed during active generation. */
async function handlePrompt(session: Session, text: string, label?: 'steering', source?: string): Promise<void> {
	// Self-fencing: if leadership moved to another PID, this process must not
	// emit prompts or start generations. The real host will handle the command.
	if (!ipc.ownsHostLock()) return

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

	// Build a SessionState for the commands module
	const sessionState: SessionState = {
		id: session.id,
		name: session.name,
		model: session.model,
		cwd: session.cwd,
		createdAt: session.createdAt,
		sessions: activeSessions.map((item) => ({ id: item.id, name: item.name })),
	}

	// Check for slash commands first
	const cmdResult = await commands.executeCommand(text, sessionState, (msg, level) =>
		emitInfo(session.id, msg, level),
	)

	if (cmdResult.handled) {
		// Sync any mutations back to session (e.g. /model, /cd)
		const cwdChanged = session.cwd !== sessionState.cwd
		const modelChanged = session.model !== sessionState.model
		session.model = sessionState.model
		session.cwd = sessionState.cwd

		// Persist changed metadata to disk and notify clients
		if (cwdChanged || modelChanged) {
			void sessionStore.updateMeta(session.id, {
				workingDir: session.cwd,
				model: session.model,
			})
			broadcastSessions()
		}

		if (cmdResult.output) emitInfo(session.id, cmdResult.output)
		if (cmdResult.error) emitInfo(session.id, cmdResult.error, 'error')
		return
	}

	// Not a command — forward to the agent loop
	await runGeneration(session, text, source)
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
	// blob refs (logContent) so the ASONL file stays small.
	if (text) {
		const resolved = await attachments.resolve(session.id, text)
		await sessionStore.appendHistory(session.id, [
			{
				role: 'user',
				content: resolved.logContent,
				source,
				ts: new Date().toISOString(),
			},
		])
	}

	// Load conversation history and convert to API messages
	const messages = apiMessages.toAnthropicMessages(session.id)

	// Emit stream-start so clients know generation is happening
	ipc.appendEvent({
		type: 'stream-start',
		sessionId: session.id,
		createdAt: new Date().toISOString(),
	})

	try {
		await agentLoop.runAgentLoop({
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
				ipc.appendEvent({
					type: 'status',
					sessionId: session.id,
					busy,
					activity,
					createdAt: new Date().toISOString(),
				})
			},
		})
	} catch (err: any) {
		emitInfo(session.id, `Generation failed: ${err?.message ?? String(err)}`, 'error')
	}
}

// ── Compaction ──

async function runCompact(session: Session): Promise<void> {
	if (!ipc.ownsHostLock()) return
	if (agentLoop.isActive(session.id)) {
		emitInfo(session.id, 'Session is busy')
		return
	}

	const entries = sessionStore.loadHistory(session.id)
	const userMsgs = entries.filter((entry) => entry.role === 'user')
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
		{ role: 'user', content: `[system] Session was manually compacted. Previous conversation: ${oldLog}`, ts },
		{ role: 'user', content: contextText, ts },
	])

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
			// Fire-and-forget: don't block the command loop on generation.
			void handlePrompt(session, cmd.text ?? '')
			break
		}

		case 'steer': {
			// Steering: user sent a prompt while generation was active.
			// Abort current generation, inject the steering message, restart.
			if (!session) return
			if (agentLoop.isActive(session.id)) {
				agentLoop.abort(session.id)
				// Brief yield so the abort propagates before we start a new generation
				await Bun.sleep(50)
			}
			void handlePrompt(session, cmd.text ?? '', 'steering')
			break
		}

		case 'abort': {
			if (!sessionId) return
			const aborted = agentLoop.abort(sessionId)
			if (!aborted) emitInfo(sessionId, 'No active generation to abort')
			break
		}

		case 'compact': {
			if (!session) return
			await runCompact(session)
			break
		}

		case 'open': {
			if (typeof cmd.text === 'string' && cmd.text.startsWith('fork:')) {
				await createForkSession(cmd.text.slice(5))
			} else {
				await createSession()
			}
			broadcastSessions()
			break
		}

		case 'resume': {
			const resumeId = String(cmd.text ?? '').trim()
			if (!resumeId) break
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

		case 'close': {
			if (!sessionId) return
			// Abort any active generation
			agentLoop.abort(sessionId)
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
	activeRuntimePid = process.pid; activeSessions = []; sessionStore.deactivateAllSessions()

	// Load session metadata only (no history — clients load that themselves).
	const metas = sessionStore.loadSessionMetas()

	if (metas.length > 0) {
		for (const meta of metas) {
			const dirName = meta.workingDir?.split('/').pop()
			activeSessions.push({
				id: meta.id,
				name: meta.topic ?? dirName ?? `tab ${activeSessions.length + 1}`,
				model: meta.model,
				cwd: meta.workingDir ?? process.cwd(),
				createdAt: meta.createdAt,
			})
		}
	} else {
		// First run — create and persist the initial tab, then publish it.
		// New clients bootstrap from state.ason, so we must not broadcast a tab
		// until its session files and shared state are actually on disk.
		void createSession().then(() => {
			if (signal.aborted || activeRuntimePid !== process.pid) return
			broadcastSessions()
		})
	}

	ipc.updateState((state) => {
		state.busy = {}
		state.activity = {}
	})
	if (metas.length > 0) syncSharedState()

	// Refresh models.dev context window cache (fire-and-forget)
	models.refreshModels().catch(() => {})

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
				const toolNames = interrupted.map(t => t.name).join(', ')
				emitInfo(session.id, `Resolving ${interrupted.length} interrupted tool(s): ${toolNames}`)
				for (const t of interrupted) {
					await sessionStore.appendHistory(session.id, [{
						role: 'tool_result',
						tool_use_id: t.id,
						ts: new Date().toISOString(),
						text: '[interrupted]',
					}])
				}
			}

			// 2. Check if the session has a pending turn (user sent prompt or
			//    tool results were written, but model never responded). If so,
			//    and the turn is recent (<30s), auto-continue generation.
			const allEntries = interrupted.length > 0
				? sessionStore.loadAllHistory(session.id) // re-read with new tool_results
				: entries
			let lastRole: string | undefined
			let lastTs: string | undefined
			let paused = false
			for (let i = allEntries.length - 1; i >= 0; i--) {
				const e = allEntries[i]!
				if (e.type === 'info' && (e as any).text === '[paused]') { paused = true; break }
				if (e.role && !lastRole) { lastRole = e.role; lastTs = e.ts }
				if (lastRole) break
			}
			const stale = lastTs && (Date.now() - new Date(lastTs).getTime()) > 30_000
			if (!paused && !stale && (lastRole === 'user' || lastRole === 'tool_result')) {
				emitInfo(session.id, 'Continuing...')
				void runGeneration(session, '') // empty text = continue existing conversation
			}
		}
	})()

	// Tail commands and dispatch
	void (async () => {
		for await (const cmd of ipc.tailCommands(signal)) {
			if (signal.aborted || activeRuntimePid !== process.pid) break
			// Self-fencing: the old host must stop reading shared commands as soon
			// as leadership moves to another PID.
			if (!ipc.ownsHostLock()) break
			// Most commands target a live session. But tab-management commands can
			// legitimately arrive with a stale sessionId during the brief window after
			// Ctrl-W, before the client has processed the sessions update and switched
			// its active tab locally.
			const hasLiveSession = !cmd.sessionId || activeSessions.some((s) => s.id === cmd.sessionId)
			if (!hasLiveSession && cmd.type !== 'open' && cmd.type !== 'resume') continue
			try {
				await handleCommand(cmd, signal)
			} catch (err: any) {
				// Don't let a single command crash the runtime
				const sid = cmd.sessionId ?? activeSessions[0]?.id
				if (sid) emitInfo(sid, `Command error: ${err?.message ?? String(err)}`, 'error')
			}
		}
	})()

	// Initialize MCP servers (external tool servers from mcp.json).
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
		.catch(() => {
			// MCP module not critical — silently ignore if it fails to load
		})

	// Start inbox watcher (external messages)
	void import('../runtime/inbox.ts')
		.then(({ inbox }) => {
			inbox.startWatching(signal, (sessionId, text, source) => {
				const session = findSession(sessionId)
				if (session) handlePrompt(session, text, undefined, source)
			})
		})
		.catch(() => {
			// Inbox module not critical — silently ignore if it fails to load
		})
}

export const runtime = { startRuntime }
