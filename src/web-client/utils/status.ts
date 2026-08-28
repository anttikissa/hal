import type { SharedSessionInfo } from '../../common/ipc.ts'
import { models } from '../../common/models.ts'
import type { SessionMeta } from '../../common/session.ts'

// The phone version of the terminal status line. A phone header has room for
// roughly one line, so this keeps only who am I, which model and how full is
// the context. The working directory lives above the composer instead: it is
// the one part that must stay readable in full, and truncating it to a single
// segment left the app looking like it had no idea where it was.

function contextText(meta: SessionMeta | undefined): string {
	const context = meta?.context
	if (!context || context.max <= 0) return ''
	const percent = Math.round((context.used / context.max) * 100)
	return `${models.formatTokenCount(context.used)}/${models.formatTokenCount(context.max)} (${percent}%)`
}

// A session name equal to the id carries no information, so drop the suffix.
function sessionText(session: SharedSessionInfo): string {
	if (!session.name || session.name === session.id) return session.id
	return `${session.id}: ${session.name}`
}

function text(session: SharedSessionInfo | undefined, meta: SessionMeta | undefined): string {
	if (!session) return ''
	const parts = [
		sessionText(session),
		models.displayModel(session.model),
		contextText(meta),
	]
	return parts.filter(Boolean).join(' · ')
}

export const webStatus = { text, contextText, sessionText }
