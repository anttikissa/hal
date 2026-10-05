// /go switches only clients following the session that runs it.
import { resolve } from 'path'
import { commands, type SlashCommand } from '../commands.ts'
import { host } from '../host.ts'
import { sessions } from '../sessions.ts'
import { tabs } from '../tabs.ts'

// Closed sessions, newest closed first, as /tabs all orders them.
const closed = () => {
	let open = tabs.file().open
	let when = (s: { meta?: { closedAt?: string; createdAt?: string } }) => s.meta?.closedAt ?? s.meta?.createdAt ?? ''
	return sessions.list().filter((s) => s.meta && !open.includes(s.id)).sort((a, b) => when(b).localeCompare(when(a)))
}

export const command: SlashCommand = {
	help: () => '/go <tab number|session id|name|directory>: go to a session, reopening it if closed. A directory picks its first open tab, else its newest session.',
	complete(args) {
		let list = tabs.list()
		let shut = closed()
		let names = [...list.flatMap((t, i) => [String(i + 1), t.id, t.name]), ...shut.flatMap((s) => [s.id, s.meta!.name ?? s.id])]
		let dirs = [...new Set([...list.map((t) => t.cwd), ...shut.map((s) => s.meta!.cwd)])]
		let path = (value: string) => args.startsWith('~/') && value.startsWith(commands.home() + '/') ? '~' + value.slice(commands.home().length) : value
		return [...new Set([...names, ...dirs.map(path)])].filter((value) => value.startsWith(args))
	},
	run(args, _answers, ctx) {
		if (!args.trim()) return { error: 'give a tab number, session id, name or directory' }
		let list = tabs.list()
		let byNumber = /^[1-9]\d*$/.test(args) && Number.isSafeInteger(Number(args)) ? list[Number(args) - 1] : undefined
		let path = commands.expand(args, ctx.cwd)
		let target = (byNumber ?? list.find((t) => t.id === args) ?? list.find((t) => t.name === args) ?? list.find((t) => resolve(t.cwd) === path))?.id
		if (!target) {
			let shut = closed()
			target = (shut.find((s) => s.id === args) ?? shut.find((s) => s.meta!.name === args) ?? shut.find((s) => resolve(s.meta!.cwd) === path))?.id
			if (!target) return { error: `no session ${args}` }
			let outcome = tabs.act({ type: 'tab-resume', sessionId: target })
			if (outcome.refused) return { error: outcome.refused }
		}
		host.broadcast(ctx.sessionId, { type: 'go', sessionId: ctx.sessionId, tab: target })
		return {}
	},
}
