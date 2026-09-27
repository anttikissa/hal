// bash: runs a command in the session's working directory. It mutates,
// which is safe to offer because a call is recorded before it runs
// (tools.ts).

import { spawn } from 'child_process'
import { type Tool, tools } from '../tools.ts'

export const tool: Tool = {
	name: 'bash',
	description:
		'Run a command with bash -c in the working directory. Returns the exit status and stdout and stderr combined. ' +
		'No stdin; long output is cut. After the timeout the command and its children are killed.',
	parameters: {
		type: 'object',
		properties: {
			command: { type: 'string', description: 'The command to run' },
			description: {
				type: 'string',
				description: 'One short plain-language sentence for the user: what the command does and why, e.g. "Show the first 40 lines of the config"',
			},
			timeout: { type: 'integer', description: 'Timeout in ms (default: 120000)' },
		},
		required: ['command', 'description'],
	},
	run(input, ctx) {
		if (typeof input.command !== 'string' || !input.command.trim()) throw new Error('command must be a non-empty string')
		if (typeof input.description !== 'string' || !input.description.trim()) throw new Error('description must be a non-empty sentence; the command did not run')
		if (ctx.signal.aborted) throw new Error('cancelled; the command did not run')
		// Its own process group, so a stop reaches pipelines and background jobs too.
		let child = spawn('bash', ['-c', `exec 2>&1\n${input.command}`], { cwd: ctx.cwd, detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
		let kill = () => tools.killGroup(child.pid!)
		ctx.signal.addEventListener('abort', kill, { once: true })
		// Kills the whole group, so a background job holding stdout ends the call too.
		let ms = Number(input.timeout) > 0 ? Number(input.timeout) : 120_000
		let timedOut = false
		let timer = setTimeout(() => {
			timedOut = true
			kill()
		}, ms)
		// Keep only what can be shown; drain the rest so the command is not blocked.
		let out = ''
		child.stdout!.setEncoding('utf8').on('data', (d: string) => {
			if (out.length <= tools.maxChars()) out += d
		})
		return new Promise((done, fail) => {
			child.on('error', fail)
			child.on('close', (code, sig) => {
				ctx.signal.removeEventListener('abort', kill)
				clearTimeout(timer)
				let status = ctx.signal.aborted ? 'stopped by the user' : timedOut ? `timed out after ${ms / 1000}s` : sig ? `killed by ${sig}` : `exit ${code}`
				done(`[${status}]\n${out}`)
			})
		})
	},
}
