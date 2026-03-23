// Server runtime -- watches commands and generates responses.

import { ipc } from '../ipc.ts'

interface Session {
	id: string
	name: string
	createdAt: string
}

let sessions: Session[] = []
let activeRuntimePid: number | null = null

// Session IDs: MM-xxx (zero-padded month + 3-char lowercase alphanumeric)
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
		name: `tab ${sessions.length + 1}`,
		createdAt: new Date().toISOString(),
	}
	sessions.push(session)
	return session
}

function resetRuntimeState(): void {
	sessions = []
}

function broadcastSessions() {
	ipc.appendEvent({
		type: 'sessions',
		sessions: sessions.map((s) => ({ id: s.id, name: s.name })),
	})
}

function startRuntime(signal: AbortSignal): void {
	activeRuntimePid = process.pid
	resetRuntimeState()

	createSession()
	setTimeout(() => {
		if (!signal.aborted && activeRuntimePid === process.pid) broadcastSessions()
	}, 0)

	void (async () => {
		for await (const cmd of ipc.tailCommands(signal)) {
			if (signal.aborted || activeRuntimePid !== process.pid) break

			if (cmd.sessionId && !sessions.some((s) => s.id === cmd.sessionId)) continue

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
				sessions = sessions.filter((s) => s.id !== cmd.sessionId)
				if (sessions.length === 0) createSession()
				broadcastSessions()
			}
		}
	})()
}

export const runtime = { startRuntime }
