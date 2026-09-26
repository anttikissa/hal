// /help: every command by category, or one command in detail.

import { commands, type SlashCommand } from '../commands.ts'

export const command: SlashCommand = {
	description: 'list commands, or show one in detail',
	category: 'help',
	help: () => '/help lists every command by category; /help <name> shows one in detail.',
	complete: (args) => [...commands.all().keys()].filter((n) => n.startsWith(args)),
	run(args) {
		let all = commands.all()
		if (args) {
			let [name = '', ...rest] = args.replace(/^\//, '').split(/\s+/)
			let cmd = all.get(name)
			if (!cmd) return { error: `no command /${name}` }
			return { say: cmd.help?.(rest.join(' ')) ?? cmd.description }
		}
		let width = Math.max(...[...all.keys()].map((n) => n.length)) + 1
		let categories = [...new Set([...all.values()].map((c) => c.category))].sort()
		let lines = categories.flatMap((category) => [
			`${category}:`,
			...[...all].filter(([, c]) => c.category === category).map(([name, c]) => `  ${`/${name}`.padEnd(width + 2)}${c.description}`),
		])
		return { say: lines.join('\n') }
	},
}
