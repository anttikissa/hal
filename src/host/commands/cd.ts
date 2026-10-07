// /cd: changes the session's working directory, offering to create one
// that does not exist.
// Tasks: et, 6eq.

import { mkdirSync, readdirSync, statSync } from 'fs'
import { commands, type Context, type SlashCommand } from '../commands.ts'
import { paths } from '../paths.ts'

function isDir(path: string): boolean {
	return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false
}

export const command: SlashCommand = {
	help: () => '/cd <dir>: change this session\'s working directory and safely interrupt and continue active work (~ is home; relative to the current one). Offers to create a missing directory. /cd alone goes to the Hal home; /cd - goes back.',
	complete(args: string, ctx: Context): string[] {
		if (args === '~') return ['~/']
		let head = args.slice(0, args.lastIndexOf('/') + 1)
		let base = args.slice(head.length)
		let dir = commands.expand(head || '.', ctx.cwd)
		// Sorted, so an exact match precedes its longer siblings (.hal before .hal-fresh).
		return readdirSync(dir)
			.sort()
			.filter((name) => name.startsWith(base) && (base.startsWith('.') || !name.startsWith('.')) && isDir(`${dir}/${name}`))
			.map((name) => `${head}${name}/`)
	},
	run(args, answers, ctx) {
		if (args === '-' && !ctx.previousCwd) return { say: `no previous directory; still in ${ctx.cwd}` }
		let path = !args ? paths.home() : args === '-' ? ctx.previousCwd! : commands.expand(args, ctx.cwd)
		let stat = statSync(path, { throwIfNoEntry: false })
		if (stat && !stat.isDirectory()) return { error: `${path}: not a directory` }
		if (!stat) {
			if (!answers) return { ask: { text: `${path}: directory not found. Create it?`, fields: [{ type: 'choice', name: 'create', options: ['yes', 'no'], initial: 0 }] } }
			if (answers.create !== 'yes') return { say: `still in ${ctx.cwd}` }
			mkdirSync(path, { recursive: true })
		}
		let previous = ctx.cwd
		ctx.setCwd(path)
		return { say: `Directory changed: ${previous} → ${path}` }
	},
}
