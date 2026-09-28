// /go switches only clients following the session that runs it.
import { resolve } from 'path'
import { commands, type SlashCommand } from '../commands.ts'
import { host } from '../host.ts'
import { tabs } from '../tabs.ts'

export const command: SlashCommand = {
	help: () => '/go <tab number|session id|name|directory>: show an open tab in every window showing this session. A directory picks its first open tab.',
	complete(args) {
		let list = tabs.list()
		let names = list.flatMap((t, i) => [String(i + 1), t.id, t.name])
		let dirs = [...new Set(list.map((t) => t.cwd))]
		let path = (value: string) => args.startsWith('~/') && value.startsWith(commands.home() + '/') ? '~' + value.slice(commands.home().length) : value
		return [...new Set([...names, ...dirs.map(path)])].filter((value) => value.startsWith(args))
	},
	run(args, _answers, ctx) {
		let list = tabs.list()
		let byNumber = /^[1-9]\d*$/.test(args) && Number.isSafeInteger(Number(args)) ? list[Number(args) - 1] : undefined
		let path = commands.expand(args, ctx.cwd)
		let found = byNumber ?? list.find((t) => t.id === args) ?? list.find((t) => t.name === args) ?? list.find((t) => resolve(t.cwd) === path)
		if (!found || !args.trim()) return { error: `no open tab ${args || '(give a tab number, id, name or directory)'}` }
		host.broadcast(ctx.sessionId, { type: 'go', sessionId: ctx.sessionId, tab: found.id })
		return {}
	},
}
