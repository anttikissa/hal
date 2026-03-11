// Client-side persistent state — remembers last active tab per server.

import { liveFiles } from './utils/live-file.ts'
import { CLIENT_STATE_PATH, STATE_DIR } from './state.ts'

interface ServerState {
	lastTab: string
}

interface ClientPersist {
	servers: Record<string, ServerState>
}

const serverKey = `ipc:${STATE_DIR}`

let _state: ClientPersist | null = null

function state(): ClientPersist {
	if (!_state) {
		_state = liveFiles.liveFile<ClientPersist>(CLIENT_STATE_PATH, {
			defaults: { servers: {} },
		})
	}
	return _state
}

export function getLastTab(): string | null {
	return state().servers[serverKey]?.lastTab ?? null
}

export function saveLastTab(sessionId: string): void {
	const s = state() as ClientPersist & { save?: () => void }
	if (!s.servers[serverKey]) s.servers[serverKey] = { lastTab: sessionId }
	else s.servers[serverKey].lastTab = sessionId
	s.save?.()
}

export const clientState = { getLastTab, saveLastTab }
