// bash: runs a command in the session's working directory. It mutates,
// which is safe to offer because a call is recorded before it runs
// (tools.ts).

import { jobs } from '../jobs.ts'
import type { Tool } from '../tools.ts'

export const tool: Tool = {
	name: 'bash',
	description:
		'Run a command with bash -c in the working directory. Returns the exit status and stdout and stderr combined. ' +
		'No stdin; long output is cut. After the timeout the command and its children are killed. ' +
		'background: true returns at once with the recorded call block number (unless the command fails within 100 ms) and delivers the result later as a message from "bash #<number>".',
	parameters: {
		type: 'object',
		properties: {
			command: { type: 'string', description: 'The command to run' },
			description: {
				type: 'string',
				description: 'One short plain-language sentence for the user: what the command does and why, e.g. "Show the first 40 lines of the config"',
			},
			timeout: { type: 'integer', description: 'Timeout in ms (default: 120000 foreground, 600000 background)' },
			background: { type: 'boolean', description: 'Run in the background, e.g. a long build or a server' },
		},
		required: ['command', 'description'],
	},
	async run(input, ctx) {
		if (typeof input.command !== 'string' || !input.command.trim()) throw new Error('command must be a non-empty string')
		if (typeof input.description !== 'string' || !input.description.trim()) throw new Error('description must be a non-empty sentence; the command did not run')
		if (input.background !== undefined && typeof input.background !== 'boolean') throw new Error('background must be a boolean; the command did not run')
		if (ctx.signal.aborted) throw new Error('cancelled; the command did not run')
		let given = Number(input.timeout) > 0 ? Number(input.timeout) : undefined
		// Escape does not stop a background job, but its timer always does.
		if (input.background) return jobs.start(ctx.sessionId, input.command, ctx.cwd, given ?? jobs.backgroundMs(), ctx.callId)
		let run = jobs.exec(input.command, ctx.cwd, given ?? 120_000, ctx.onOutput)
		ctx.signal.addEventListener('abort', run.stop, { once: true })
		try {
			return await run.done
		} finally {
			ctx.signal.removeEventListener('abort', run.stop)
		}
	},
}
