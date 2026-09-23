import type { SharedState } from '../common/ipc.ts'
import type { Command } from '../common/protocol.ts'
import { dirs } from '../utils/dirs.ts'

interface ClientTransport {
	appendCommand: (command: Command) => void
	notifyDraftSaved: (sessionId: string) => void
	uploadImage: ((data: Uint8Array) => Promise<string>) | null
	readState: () => SharedState
	watchState: (callback: (state: SharedState) => void, signal: AbortSignal) => void
	tailEvents: (signal?: AbortSignal) => AsyncGenerator<any>
	// Remote hosts answer asynchronously because the directories live on their disk.
	completeDirs: (argPrefix: string, cwd: string) => string[] | Promise<string[]>
}

async function* emptyEvents(): AsyncGenerator<any> {}

const io: ClientTransport = {
	appendCommand: () => {},
	notifyDraftSaved: () => {},
	uploadImage: null,
	readState: () => ({ sessions: [], working: {}, updatedAt: new Date().toISOString() }),
	watchState: () => {},
	tailEvents: emptyEvents,
	completeDirs: dirs.complete,
}

function install(transport: Partial<ClientTransport>): void {
	Object.assign(io, transport)
}

export const clientTransport = { io, install }
