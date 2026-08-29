import type { SharedSessionInfo } from '../../common/ipc.ts'
import { models } from '../../common/models.ts'
import type { SessionMeta } from '../../common/session.ts'

// The phone version of the terminal status line, split over two rows because a
// phone header only has room for one. `text` is the header: who am I and how
// full is the context. `location` sits above the composer and answers where and
// with what this prompt will run, keeping the terminal's cwd-then-model pairing.

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

function location(session: SharedSessionInfo | undefined): string {
	if (!session) return ''
	return [session.cwd, models.displayModel(session.model)].filter(Boolean).join(' · ')
}

function text(session: SharedSessionInfo | undefined): string {
	if (!session) return ''
	return webStatus.sessionText(session)
}

export const webStatus = { text, location, contextText, sessionText }
