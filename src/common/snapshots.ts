import type { HistoryEntry } from './history.ts'
import type { SharedSessionInfo } from './ipc.ts'
import type { LiveBlock } from './live-event-blocks.ts'

// Complete browser-safe bootstrap data for one open session. The server owns
// loading it; clients own projection and presentation after receipt.
export interface ClientSessionSnapshot {
	session: SharedSessionInfo
	history: HistoryEntry[]
	live: LiveBlock[]
}
