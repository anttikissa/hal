// /cd: changes the session's working directory, offering to create one
// that does not exist.

import { mkdirSync, readdirSync, statSync } from 'fs'
import { commands, type Context, type SlashCommand } from '../commands.ts'

function isDir(path: string): boolean {
	return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false
}

export const command: SlashCommand = {
	help: () => '/cd <dir>: change the working directory of this session (~ is home; relative to the current one). Offers to create a missing directory. /cd alone shows it.',
	complete(args: string, ctx: Context): string[] {
		if (args === '~') return ['~/']
		let head = args.slice(0, args.lastIndexOf('/') + 1)
		let base = args.slice(head.length)
		let dir = commands.expand(head || '.', ctx.cwd)
		return readdirSync(dir)
			.filter((name) => name.startsWith(base) && (base.startsWith('.') || !name.startsWith('.')) && isDir(`${dir}/${name}`))
			.map((name) => `${head}${name}/`)
	},
	run(args, answers, ctx) {
		if (!args) return { say: ctx.cwd }
		let path = commands.expand(args, ctx.cwd)
		let stat = statSync(path, { throwIfNoEntry: false })
		if (stat && !stat.isDirectory()) return { error: `${path}: not a directory` }
		if (!stat) {
			if (!answers) return { ask: { text: `${path}: directory not found. Create it?`, fields: [{ type: 'choice', name: 'create', options: ['yes', 'no'], initial: 0 }] } }
			if (answers.create !== 'yes') return { say: `still in ${ctx.cwd}` }
			mkdirSync(path, { recursive: true })
		}
		ctx.setCwd(path)
		return { say: `now in ${path}` }
	},
}
