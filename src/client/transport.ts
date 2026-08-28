import type { SharedState } from '../common/ipc.ts'
import type { Command } from '../common/protocol.ts'

interface ClientTransport {
	appendCommand: (command: Command) => void
	notifyDraftSaved: (sessionId: string) => void
	uploadImage: ((data: Uint8Array) => Promise<string>) | null
	readState: () => SharedState
	watchState: (callback: (state: SharedState) => void, signal: AbortSignal) => void
	tailEvents: (signal?: AbortSignal) => AsyncGenerator<any>
}

async function* emptyEvents(): AsyncGenerator<any> {}

const io: ClientTransport = {
	appendCommand: () => {},
	notifyDraftSaved: () => {},
	uploadImage: null,
	readState: () => ({ sessions: [], working: {}, updatedAt: new Date().toISOString() }),
	watchState: () => {},
	tailEvents: emptyEvents,
}

function install(transport: Partial<ClientTransport>): void {
	Object.assign(io, transport)
}

export const clientTransport = { io, install }
