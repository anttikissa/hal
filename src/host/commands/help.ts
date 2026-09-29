// /help: every command by category with its key, or one command in
// detail. Client-only commands are listed too (common/commands/list.ts).

import { commandList } from '../../common/commands/list.ts'
import { commands, type SlashCommand } from '../commands.ts'

export const command: SlashCommand = {
	help: () => '/help lists every command by category; /help <name> shows one in detail.',
	complete: (args) => commandList.all().map((c) => c.name).filter((n) => n.startsWith(args)),
	run(args) {
		let all = commandList.all().filter((c) => !c.hidden)
		if (args) {
			let [name = '', ...rest] = args.replace(/^\//, '').split(/\s+/)
			let info = commandList.byName(name)
			if (!info) return { error: `no command /${name}` }
			return { say: commands.all().get(name)?.help?.(rest.join(' ')) ?? info.description }
		}
		let width = Math.max(...all.map((c) => c.name.length)) + 1
		let keys = Math.max(...all.map((c) => c.key?.length ?? 0))
		let categories = [...new Set(all.map((c) => c.category))].sort()
		let lines = categories.flatMap((category) => [
			`${category}:`,
			...all.filter((c) => c.category === category).map((c) => `  ${`/${c.name}`.padEnd(width + 2)}${(c.key ?? '').padEnd(keys + 2)}${c.description}`),
		])
		return { say: lines.join('\n') }
	},
}
