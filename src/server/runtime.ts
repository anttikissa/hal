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

	// Persist: write session.ason and update the session list in state.ason
	await sessionStore.createSession(session.id, {
		id: session.id,
		workingDir: session.cwd,
		createdAt: session.createdAt,
		topic: undefined,
	})
	await persistSessionList()
	return session
}

/** Write the current in-memory session order to disk. */
async function persistSessionList(): Promise<void> {
	await sessionStore.saveSessionList(activeSessions.map(s => s.id))
}

function findSession(sessionId: string): Session | undefined {
	return activeSessions.find(s => s.id === sessionId)
}

// ── IPC helpers ──

function broadcastSessions(): void {
	ipc.appendEvent({
		type: 'sessions',
		sessions: activeSessions.map(s => ({ id: s.id, name: s.name })),
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

/** Process a prompt: check for slash commands, then forward to agent loop. */
async function handlePrompt(session: Session, text: string): Promise<void> {
	// Emit the prompt event so clients see what was typed
	ipc.appendEvent({
		type: 'prompt',
		text,
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
	}

	// Check for slash commands first
	const cmdResult = await commands.executeCommand(
		text,
		sessionState,
		(msg, level) => emitInfo(session.id, msg, level),
	)

	if (cmdResult.handled) {
		// Sync any mutations back to session (e.g. /model, /cd)
		const cwdChanged = session.cwd !== sessionState.cwd
		const modelChanged = session.model !== sessionState.model
		session.model = sessionState.model
		session.cwd = sessionState.cwd

		// Persist changed metadata to disk
		if (cwdChanged || modelChanged) {
			void sessionStore.updateMeta(session.id, {
				workingDir: session.cwd,
				model: session.model,
			})
		}

		if (cmdResult.output) emitInfo(session.id, cmdResult.output)
		if (cmdResult.error) emitInfo(session.id, cmdResult.error, 'error')
		return
	}

	// Not a command — forward to the agent loop
	await runGeneration(session, text)
}

/** Start a generation (agent loop call) for a session. */
async function runGeneration(session: Session, text: string): Promise<void> {
	const model = session.model ?? models.defaultModel()

	// Build system prompt
	const promptResult = context.buildSystemPrompt({
		model,
		cwd: session.cwd,
	})

	// Save user prompt to history
	await sessionStore.appendHistory(session.id, [{
		role: 'user',
		content: text,
		ts: new Date().toISOString(),
	}])

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

// ── Command dispatch ──

async function handleCommand(cmd: any, signal: AbortSignal): Promise<void> {
	const sessionId = cmd.sessionId
	const session = sessionId ? findSession(sessionId) : activeSessions[0]

	switch (cmd.type) {
		case 'prompt': {
			if (!session) return
			await handlePrompt(session, cmd.text ?? '')
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
			// Compaction requires history (Plan 3). For now, just acknowledge.
			emitInfo(session.id, 'Compaction not yet implemented (needs Plan 3: Session)')
			break
		}

		case 'open': {
			await createSession()
			broadcastSessions()
			break
		}

		case 'close': {
			if (!sessionId) return
			// Abort any active generation
			agentLoop.abort(sessionId)
			activeSessions = activeSessions.filter(s => s.id !== sessionId)
			if (activeSessions.length === 0) await createSession()
			await persistSessionList()
			broadcastSessions()
			break
		}
	}
}

// ── Main entry point ──

function startRuntime(signal: AbortSignal): void {
	activeRuntimePid = process.pid
	activeSessions = []

	// Load session metadata only (no history — clients load that themselves).
	const metas = sessionStore.loadSessionMetas()

	if (metas.length > 0) {
		for (const meta of metas) {
			const dirName = meta.workingDir?.split('/').pop()
			activeSessions.push({
				id: meta.id,
				name: meta.topic ?? dirName ?? `tab ${activeSessions.length + 1}`,
				cwd: meta.workingDir ?? process.cwd(),
				createdAt: meta.createdAt,
			})
		}
	} else {
		// First run — create and persist the initial tab.
		// We can't top-level await in startRuntime, so fire-and-forget.
		// The session is in memory immediately; disk write follows.
		void createSession()
	}

	// Broadcast session list on next tick so client tail is ready
	setTimeout(() => {
		if (signal.aborted || activeRuntimePid !== process.pid) return
		broadcastSessions()
	}, 0)

	// Tail commands and dispatch
	void (async () => {
		for await (const cmd of ipc.tailCommands(signal)) {
			if (signal.aborted || activeRuntimePid !== process.pid) break
			// Skip commands for sessions that don't exist
			if (cmd.sessionId && !activeSessions.some(s => s.id === cmd.sessionId)) continue
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
	void import('../mcp/client.ts').then(({ mcp }) => {
		mcp.initServers().catch((err: any) => {
			console.error(`[mcp] init failed: ${err?.message ?? String(err)}`)
		})
		// Clean up MCP servers on shutdown
		signal.addEventListener('abort', () => { void mcp.shutdown() }, { once: true })
	}).catch(() => {
		// MCP module not critical — silently ignore if it fails to load
	})

	// Start inbox watcher (external messages)
	void import('../runtime/inbox.ts').then(({ inbox }) => {
		inbox.startWatching(signal, (sessionId, text) => {
			const session = findSession(sessionId)
			if (session) handlePrompt(session, text)
		})
	}).catch(() => {
		// Inbox module not critical — silently ignore if it fails to load
	})
}

export const runtime = { startRuntime }
