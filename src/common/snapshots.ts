import type { HistoryEntry } from './history.ts'
import type { SharedSessionInfo, SharedState } from './ipc.ts'
import type { LiveBlock } from './live-event-blocks.ts'
import type { SessionMeta } from './session.ts'

// Complete browser-safe bootstrap data for one open session. The server owns
// loading it; clients own projection and presentation after receipt.
export interface ClientSessionSnapshot {
	session: SharedSessionInfo
	meta: SessionMeta
	history: HistoryEntry[]
	parentCount: number
	parentId?: string
	live: LiveBlock[]
}

export interface ClientBootstrap {
	state: SharedState
	metas: SessionMeta[]
	snapshots: ClientSessionSnapshot[]
}
