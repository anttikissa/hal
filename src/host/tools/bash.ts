// bash: runs a command in the session's working directory. It mutates,
// which is safe to offer because a call is recorded before it runs
// (tools.ts).

import { spawn } from 'child_process'
import { type Tool, tools } from '../tools.ts'

export const tool: Tool = {
	name: 'bash',
	description:
		'Run a command with bash -c in the working directory. Returns the exit status and stdout and stderr combined. ' +
		'No stdin; long output is cut.',
	parameters: {
		type: 'object',
		properties: {
			command: { type: 'string', description: 'The command to run' },
			description: {
				type: 'string',
				description: 'One short plain-language sentence for the user: what the command does and why, e.g. "Show the first 40 lines of the config"',
			},
		},
		required: ['command', 'description'],
	},
	run(input, ctx) {
		if (typeof input.command !== 'string' || !input.command.trim()) throw new Error('command must be a non-empty string')
		if (typeof input.description !== 'string' || !input.description.trim()) throw new Error('description must be a non-empty sentence; the command did not run')
		if (ctx.signal.aborted) throw new Error('cancelled; the command did not run')
		// Its own process group, so cancel stops pipelines and children too.
		let child = spawn('bash', ['-c', `exec 2>&1\n${input.command}`], { cwd: ctx.cwd, detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
		let kill = () => {
			try {
				process.kill(-child.pid!, 'SIGKILL')
			} catch {}
		}
		ctx.signal.addEventListener('abort', kill, { once: true })
		// Keep only what can be shown; drain the rest so the command is not blocked.
		let out = ''
		child.stdout!.setEncoding('utf8').on('data', (d: string) => {
			if (out.length <= tools.maxChars()) out += d
		})
		return new Promise((done, fail) => {
			child.on('error', fail)
			child.on('close', (code, sig) => {
				ctx.signal.removeEventListener('abort', kill)
				let status = ctx.signal.aborted ? 'cancelled' : sig ? `killed by ${sig}` : `exit ${code}`
				done(`[${status}]\n${out}`)
			})
		})
	},
}
