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
