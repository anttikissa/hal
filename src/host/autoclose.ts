// Automatic tab closure is a session property, independent of spawn kind.
// Changes are durable transcript output; metadata pushes update both titles.
// Tasks: p87.
import { history } from './history.ts'
import { host } from './host.ts'
import { jobs } from './jobs.ts'
import { liveFiles } from './live-file.ts'
import { notify } from './notify.ts'
import { sessions } from './sessions.ts'
import { status } from './status.ts'
import { subagents } from './subagents.ts'
import { tabs } from './tabs.ts'

function set(id: string, value: boolean): void {
	let meta = sessions.open(id)
	let previous = meta.autoclose ?? false
	if (previous === value) return
	meta.autoclose = value
	liveFiles.save(meta)
	let text = `Autoclose: ${previous ? 'on' : 'off'} → ${value ? 'on' : 'off'}`
	let { n, ts } = history.append(id, { type: 'output', text })
	host.broadcast(id, { type: 'output', sessionId: id, text, n, ts })
	host.broadcast(id, { type: 'meta', sessionId: id, meta: { ...meta } })
}

// An initial prompt keeps explicitly selected autoclose; steering existing
// work gives the human ownership. Queued follow-ups never call this hook.
function promote(id: string): void {
	if (!sessions.open(id).autoclose) return
	if (history.readSync(id).some((r) => r.type === 'user' || r.type === 'assistant' || r.type === 'continue')) autoclose.set(id, false)
}

// Called only after a completed turn. Idle plus empty work lists prevents
// closing a waiting parent, a question, or a session with queued follow-ups.
function finished(id: string): void {
	if (!sessions.open(id).autoclose || status.stateOf(id).type !== 'idle') return
	if (notify.asked(id) || status.inboxOf(id).length || subagents.running(id).length || jobs.running(id).length) return
	if (tabs.close(id) === undefined) tabs.publish()
}

export const autoclose = { set, promote, finished }
