import type { SharedSessionInfo } from '../../common/ipc.ts'
import { models } from '../../common/models.ts'
import type { SessionMeta } from '../../common/session.ts'

// The phone version of the terminal status line. A phone header has room for
// roughly one line, so this keeps only what the terminal shows on the left:
// who am I, where am I, which model, how full is the context.

// Only the last path segment fits on a phone, and it is the part that
// identifies the project. "/" has no segment, so show it as-is.
function shortCwd(cwd: string): string {
	if (!cwd) return ''
	const name = cwd.split('/').filter(Boolean).at(-1)
	return name ?? '/'
}

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
		shortCwd(session.cwd),
		models.displayModel(session.model),
		contextText(meta),
	]
	return parts.filter(Boolean).join(' · ')
}

export const webStatus = { text, shortCwd, contextText, sessionText }
