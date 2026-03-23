// Server runtime -- watches commands and generates responses.
// Broadcasts session list via IPC. Does NOT broadcast history --
// clients load that directly from disk.

import { ipc } from '../ipc.ts'
import { sessions as sessionStore } from './sessions.ts'

interface Session {
	id: string
	name: string
	createdAt: string
}

let activeSessions: Session[] = []
let activeRuntimePid: number | null = null

function makeSessionId(): string {
	const month = String(new Date().getMonth() + 1).padStart(2, '0')
	const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
	let suffix = ''
	for (let i = 0; i < 3; i++)
		suffix += chars[Math.floor(Math.random() * chars.length)]
	return `${month}-${suffix}`
}

function createSession(): Session {
	const session: Session = {
		id: makeSessionId(),
		name: `tab ${activeSessions.length + 1}`,
		createdAt: new Date().toISOString(),
	}
	activeSessions.push(session)
	return session
}

function broadcastSessions() {
	ipc.appendEvent({
		type: 'sessions',
		sessions: activeSessions.map(s => ({ id: s.id, name: s.name })),
	})
}

function startRuntime(signal: AbortSignal): void {
	activeRuntimePid = process.pid
	activeSessions = []

	// Load persisted sessions from disk.
	const loaded = sessionStore.loadAllSessions()

	if (loaded.length > 0) {
		for (const s of loaded) {
			activeSessions.push({
				id: s.meta.id,
				name: s.meta.topic ?? `tab ${activeSessions.length + 1}`,
				createdAt: s.meta.createdAt,
			})
		}
	} else {
		createSession()
	}

	// Broadcast session list on next tick so client tail is ready.
	setTimeout(() => {
		if (signal.aborted || activeRuntimePid !== process.pid) return
		broadcastSessions()
	}, 0)

	void (async () => {
		for await (const cmd of ipc.tailCommands(signal)) {
			if (signal.aborted || activeRuntimePid !== process.pid) break
			if (cmd.sessionId && !activeSessions.some(s => s.id === cmd.sessionId)) continue

			if (cmd.type === 'prompt') {
				ipc.appendEvent({
					type: 'prompt',
					text: cmd.text,
					sessionId: cmd.sessionId,
					createdAt: cmd.createdAt,
				})
				ipc.appendEvent({
					type: 'response',
					text: `You said: ${cmd.text}`,
					sessionId: cmd.sessionId,
				})
			} else if (cmd.type === 'open') {
				createSession()
				broadcastSessions()
			} else if (cmd.type === 'close' && cmd.sessionId) {
				activeSessions = activeSessions.filter(s => s.id !== cmd.sessionId)
				if (activeSessions.length === 0) createSession()
				broadcastSessions()
			}
		}
	})()
}

export const runtime = { startRuntime }
