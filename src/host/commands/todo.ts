// Project TODOs (task 8q): disk is authoritative when TODO.md exists.
import { appendFileSync, existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { states } from '../../common/states.ts'
import type { SlashCommand } from '../commands.ts'
import { prompts } from '../prompts.ts'
import { status } from '../status.ts'
import { subagents } from '../subagents.ts'

export const command: SlashCommand = {
	help: () => '/todo <item>: append and commit an item in this directory’s TODO.md, or ask the model to file it. A busy session delegates to a subagent, spending one spawn slot. Bare /todo lists open items.',
	async run(args, _answers, ctx) {
		let item = args.trim()
		let path = resolve(ctx.cwd, 'TODO.md')
		if (existsSync(path)) {
			let text = readFileSync(path, 'utf8')
			if (!item) {
				let open = text.split('\n').filter((line) => /^\s*[-*+]\s+(?!\[[xX]\](?:\s|$))\S/.test(line))
				return { say: open.join('\n') || 'No open TODO items.' }
			}
			appendFileSync(path, `${text && !text.endsWith('\n') ? '\n' : ''}- ${item}\n`)
			let message = `TODO: ${item}\n\nImplemented by: ${ctx.model}\nSession: ${ctx.sessionId}`
			// Async: commit hooks may take seconds; the host loop must not wait.
			for (let args of [['add', '--', 'TODO.md'], ['commit', '-m', message, '--', 'TODO.md']]) {
				let p = Bun.spawn(['git', ...args], { cwd: ctx.cwd, stdout: 'pipe', stderr: 'pipe' })
				let [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()])
				if (code !== 0) return { error: `Added to ${path}, but git ${args[0]} failed: ${err.trim() || out.trim()}` }
			}
			return { say: `Added to ${path} and committed.` }
		}
		if (!item) return { error: 'No TODO.md in this directory. Usage: /todo <item>' }
		let task = `Add a TODO item to this project: ${item}`
		if (!states.busy(status.stateOf(ctx.sessionId))) {
			let error = prompts.submit(ctx.sessionId, task)
			return error ? { error } : {}
		}
		try { subagents.spawn(ctx.sessionId, { kind: 'subagent', task, fork: false, cwd: ctx.cwd, limit: 0 }) }
		catch (e) { return { error: `No TODO.md in ${ctx.cwd}, and this session is busy, so /todo needs a subagent: ${e instanceof Error ? e.message : String(e)}` } }
		return {}
	},
}
