// Session metadata as stored in sessions/<id>/session.ason. Browser-safe
// shape only; the host owns reading and writing it.
// Tasks: gj, p87.
export interface SessionMeta {
	id: string
	// Working directory and provider/model id for the next turn.
	cwd: string
	// The directory the last /cd left, for /cd -.
	previousCwd?: string
	model: string
	// Explicit request override; omitted uses provider policy.
	effort?: string
	// ISO timestamp.
	createdAt: string
	// Last tab closure, retained after reopening.
	closedAt?: string
	name?: string
	nameOwner?: 'auto' | 'manual'
	nameVersion?: number
	nameTurns?: number
	// Close after a successful final turn once no work remains (task p87).
	autoclose?: boolean
	// Spawn kinds differ in their initial autoclose value; interactive is the user's.
	parent?: string
	spawn?: SpawnKind
	// Spawn slots left; none yet means the first session's allowance.
	slots?: number
	// Ids of background bash commands still running (task v0).
	background?: string[]
}

export type SpawnKind = 'subagent' | 'subagent-leave-open' | 'interactive'

// Whether `s` is shaped like a session id ("<n>-<abc>", as the host
// makes them): the web address /<id> names a tab only then.
function isId(s: string): boolean {
	return /^\d+-[a-z]{3}$/.test(s)
}

export const session = { isId }
