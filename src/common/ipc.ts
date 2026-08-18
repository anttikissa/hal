import type { VersionStatus } from './protocol.ts'

export type ContinuationAction = 'continue' | 'retry'

// Browser-safe snapshot stored by the file IPC transport and exposed to clients.
// Transport implementations own serialization and delivery, not these contracts.
export interface SharedSessionInfo {
	// 1-based visible tab number. Stored explicitly so humans and agents do not
	// need to count large session arrays by hand.
	id: string
	tab?: number
	name?: string
	cwd: string
	model?: string
	currentLog?: string
	continuation?: ContinuationAction
	attention?: 'new'
}

export interface SharedHostInfo {
	pid: number | null
	startedAt: string
	versionStatus: VersionStatus
	version?: string
	error?: string
}

export interface SharedClientInfo {
	pid: number
	startedAt: string
	updatedAt: string
	sessionId?: string
	cwd?: string
	versionStatus: VersionStatus
	version?: string
	error?: string
}

export interface SharedState {
	sessions: SharedSessionInfo[]
	working: Record<string, boolean>
	summarizing?: Record<string, boolean>
	host?: SharedHostInfo
	clients?: SharedClientInfo[]
	updatedAt: string
}
