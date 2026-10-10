// bash: runs a command in the session's working directory. It mutates,
// which is safe to offer because a call is recorded before it runs
// (tools.ts).
// Tasks: gr, a5, 8w, nvm.

import { jobs } from '../jobs.ts'
import { fileChanges } from '../file-changes.ts'
import { actions } from '../actions.ts'
import type { Tool } from '../tools.ts'

// The command without a leading `cd <cwd> &&`: it runs in cwd anyway,
// and the repeat crowds the call's one-line title.
function withoutCd(command: string, cwd: string): string {
	let m = command.match(/^\s*cd\s+(?:'([^']*)'|"([^"$`\\]*)"|([^\s'"$`\\;&|]+))\s*&&\s*/)
	let dir = m && (m[1] ?? m[2] ?? m[3])!.replace(/(.)\/+$/, '$1')
	return m && dir === cwd.replace(/(.)\/+$/, '$1') ? command.slice(m[0].length) : command
}

export const bash = { withoutCd }

export const tool: Tool = {
	name: 'bash',
	description:
		'Run a command with bash -c in the working directory. Returns the exit status and stdout and stderr combined. ' +
		'No stdin; long output is cut. After the timeout the command and its children are killed. ' +
		'background: true returns at once with the recorded call block number (unless the command fails within 100 ms) and delivers the result later as a message from "bash #t<number>".',
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
			// Its effect stays unsaid (task ker): steering lets it finish.
			unsafeToStop: { type: 'boolean', description: 'Use when stopping halfway might leave broken state (e.g. disk partitioning, database migrations, server provisioning).' },
			modifies: { type: 'array', items: { type: 'string' }, description: 'Absolute or cwd-relative paths/globs this command creates, changes or deletes. All directories are accepted; change tracking includes only cwd and /tmp files, excluding .git, node_modules, Git-ignored untracked files and aliases to excluded files.' },
		},
		required: ['command'],
	},
	// Action timeouts are in seconds; the tool's in ms.
	action: {
		summary: false,
		positional: ['command'],
		usage: ['BASH "<command>" [{ timeout, background, unsafeToStop, modifies }]'],
		fields: { timeout: 'Seconds (default: 120 foreground, 600 background)' },
		resolve(raw) {
			let input = actions.generic(tool, raw)
			if (input.timeout !== undefined) {
				if (typeof input.timeout !== 'number' || !(input.timeout > 0)) throw new Error(`BASH timeout is a positive number of seconds, got ${JSON.stringify(input.timeout)}`)
				input.timeout = Math.round(input.timeout * 1000)
			}
			return { name: 'bash', input }
		},
	},
	async run(input, ctx) {
		if (typeof input.command !== 'string' || !input.command.trim()) throw new Error('command must be a non-empty string')
		if (input.description !== undefined && (typeof input.description !== 'string' || !input.description.trim())) throw new Error('description must be a non-empty sentence; the command did not run')
		if (input.background !== undefined && typeof input.background !== 'boolean') throw new Error('background must be a boolean; the command did not run')
		if (input.unsafeToStop !== undefined && typeof input.unsafeToStop !== 'boolean') throw new Error('unsafeToStop must be a boolean; the command did not run')
		let patterns = fileChanges.validate(input.modifies)
		if (ctx.signal.aborted) throw new Error(`${jobs.why(ctx.signal)}; the command did not run`)
		let given = Number(input.timeout) > 0 ? Number(input.timeout) : undefined
		let observation = await fileChanges.begin(ctx, patterns)
		let launched = false
		let launch = () => {
			if (ctx.signal.aborted) throw new Error(`${jobs.why(ctx.signal)}; the command did not run`)
			let run = jobs.exec(input.command as string, ctx.cwd, given ?? (input.background ? jobs.backgroundMs : 120_000), input.background ? undefined : ctx.onOutput)
			launched = true
			return { ...run, done: run.done.finally(() => fileChanges.finish(observation)) }
		}
		try {
			// Escape does not stop a background job. Its snapshot and lock
			// last until actual exit, not until the early tool result.
			if (input.background) return await jobs.start(ctx.sessionId, input.command, ctx.cwd, given, ctx.callId, launch)
			let run = launch()
			let stop = () => run.stop(jobs.why(ctx.signal, 'stopped'))
			ctx.signal.addEventListener('abort', stop, { once: true })
			try { return await run.done } finally { ctx.signal.removeEventListener('abort', stop) }
		} finally {
			if (!launched) observation.release()
		}
	},
}
