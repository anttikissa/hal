// Session metadata as stored in sessions/<id>/session.ason. Browser-safe
// shape only; the host owns reading and writing it.
export interface SessionMeta {
	id: string
	// Working directory and provider/model id for the next turn.
	cwd: string
	model: string
	// ISO timestamp.
	createdAt: string
	name?: string
}

// Whether `s` is shaped like a session id ("<n>-<abc>", as the host
// makes them): the web address /<id> names a tab only then.
function isId(s: string): boolean {
	return /^\d+-[a-z]{3}$/.test(s)
}

export const session = { isId }
