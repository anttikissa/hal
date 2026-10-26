// /trust: shows and changes remembered project trust, so the answer to
// "Trust this project?" stays visible and editable.
// Tasks: 8ks.

import { relative } from 'path'
import { commands, type SlashCommand } from '../commands.ts'
import { projectContext } from '../project-context.ts'
import { sessions } from '../sessions.ts'
import { tabs } from '../tabs.ts'

const ACTIONS = ['yes', 'no', 'forget']

function overview(cwd: string, own?: string | false): string {
	let root = projectContext.root(cwd)
	let content = projectContext.contents(cwd).map((p) => relative(root, p))
	let decided = projectContext.file().projects[root]
	let state = !content.length
		? 'nothing to trust'
		: own === false
			? 'not trusted (--no-trust)'
			: own === root
				? 'trusted (-d)'
				: decided === undefined
					? 'undecided'
					: decided
						? 'trusted'
						: 'not trusted'
	let lines = [`This project: ${root}: ${state}${content.length ? ` (${content.join(', ')})` : ''}`]
	let remembered = Object.entries(projectContext.file().projects)
	lines.push(
		remembered.length
			? `Remembered:\n${remembered.map(([dir, yes]) => `  ${dir}: ${yes ? 'trusted' : 'not trusted'}`).join('\n')}`
			: 'Remembered: none',
	)
	return lines.join('\n')
}

export const command: SlashCommand = {
	help: () =>
		"/trust: show whether this project is trusted and every remembered decision.\n/trust yes [dir]: trust the project (default: this one); Hal reads its instructions and skills and loads its plugins.\n/trust no [dir]: don't trust it; Hal skips them.\n/trust forget [dir]: forget the decision; Hal asks again.",
	complete(args) {
		let [action, ...rest] = args.split(' ')
		if (!rest.length) return ACTIONS.filter((a) => a.startsWith(action!)).map((a) => `${a} `)
		if (!ACTIONS.includes(action!)) return []
		let dir = rest.join(' ')
		return Object.keys(projectContext.file().projects)
			.filter((root) => root.startsWith(dir))
			.map((root) => `${action} ${root}`)
	},
	run(args, _answers, ctx) {
		let own = sessions.open(ctx.sessionId).projectTrust
		if (!args) return { say: overview(ctx.cwd, own) }
		let [action, ...rest] = args.split(' ')
		if (!ACTIONS.includes(action!)) return { error: 'usage: /trust [yes|no|forget] [dir]' }
		let dir = rest.length ? commands.expand(rest.join(' '), ctx.cwd) : ctx.cwd
		if (action === 'forget') projectContext.forget(dir)
		else projectContext.decide(dir, action === 'yes')
		projectContext.changed()
		tabs.publish()
		return { say: overview(dir, own) }
	},
}
