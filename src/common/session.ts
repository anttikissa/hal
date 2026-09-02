import type { SpawnKind } from './protocol.ts'

// Persisted session metadata is shared by server storage and client startup
// projections. Storage location and lifecycle remain server responsibilities.
export interface SessionMeta {
	id: string
	workingDir?: string
	createdAt: string
	name?: string
	model?: string
	currentLog?: string
	closedAt?: string
	forkedFrom?: string
	spawnKind?: SpawnKind
	attention?: 'new'
	// 1-based visible tab position at close time. Used to put Ctrl-Shift-T
	// restores back where the tab was instead of appending at the end.
	closedTabPosition?: number
	parentSessionId?: string
	/** Remaining spawn slots; recursive capacity is transferred, never copied. */
	subagentBudget?: number
	// Last known context window usage, persisted so it survives restarts.
	context?: { used: number; max: number }
}
