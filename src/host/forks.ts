// Ordinary interactive forks (task px), independent of spawn ownership.
import { host } from './host.ts'
import { sessions } from './sessions.ts'
import { slash } from './slash.ts'
import { subagents } from './subagents.ts'
import { tabs } from './tabs.ts'
import { models } from './models.ts'
import { liveFiles } from './live-file.ts'

function create(parent: string): string {
	let meta = sessions.open(parent)
	let child = sessions.create({ cwd: meta.cwd, model: models.qualified(meta.model, meta.effort) })
	// Automatic, so the fork can name itself; fits the 60-character limit.
	child.name = `${Array.from(meta.name ?? parent).slice(0, 53).join('').trimEnd()} (fork)`
	liveFiles.save(child)
	subagents.fork(parent, child.id)
	let at = tabs.file().open.indexOf(parent)
	tabs.insert(child.id, at < 0 ? tabs.file().open.length : at + 1)
	tabs.publish()
	slash.output(parent, `This session was forked to ${child.id}.`)
	host.broadcast(parent, { type: 'go', sessionId: parent, tab: child.id })
	return child.id
}

export const forks = { create }
