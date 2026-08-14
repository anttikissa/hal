import type { SharedState } from '../common/ipc.ts'
import type { Command } from '../common/protocol.ts'

interface ClientTransport {
	appendCommand: (command: Command) => void
	notifyDraftSaved: (sessionId: string) => void
	readState: () => SharedState
	tailEvents: (signal?: AbortSignal) => AsyncGenerator<any>
}

async function* emptyEvents(): AsyncGenerator<any> {}

const io: ClientTransport = {
	appendCommand: () => {},
	notifyDraftSaved: () => {},
	readState: () => ({ sessions: [], working: {}, updatedAt: new Date().toISOString() }),
	tailEvents: emptyEvents,
}

function install(transport: Partial<ClientTransport>): void {
	Object.assign(io, transport)
}

export const clientTransport = { io, install }
