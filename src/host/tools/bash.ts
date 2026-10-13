// bash: runs a command in the session's working directory. It mutates,
// which is safe to offer because a call is recorded before it runs
// (tools.ts).
// Tasks: gr, a5, 8w, nvm.

import { jobs } from '../jobs.ts'
import { fileChanges } from '../file-changes.ts'
import type { Tool, ToolOutput } from '../tools.ts'
import type { CommitBlock } from '../../common/blocks.ts'

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
		'Run a command with bash -c in the working directory. Long output is cut.',
	parameters: {
		type: 'object',
		properties: {
			command: { type: 'string', description: 'The command to run' },
			description: {
				type: 'string',
				description: 'One short plain-language sentence for the user: e.g. "Show the first 40 lines of the config"',
			},
			timeout: { type: 'number', description: 'Seconds (default: 120 foreground, 600 background)' },
			background: { type: 'boolean', description: 'Start asynchronous task; the result will be delivered as a message from "bash t<number>"' },
			// Its effect stays unsaid (task ker): steering lets it finish.
			unsafeToStop: { type: 'boolean', description: 'Use when stopping halfway might leave broken state (e.g. disk partitioning, database migrations, server provisioning).' },
			modifies: { type: 'array', items: { type: 'string' }, description: "Absolute or cwd-relative paths/globs this command creates, changes or deletes. Don't include paths starting with .git/ or node_modules/." },
		},
		required: ['command'],
	},
	syntax: {
		summary: false,
		positional: ['command'],
		aliases: { cmd: 'command' },
		usage: ['BASH "<command>" [ { timeout, background, unsafeToStop, modifies } ]'],
	},
	async run(input, ctx) {
		if (typeof input.command !== 'string' || !input.command.trim()) throw new Error('command must be a non-empty string')
		if (input.description !== undefined && (typeof input.description !== 'string' || !input.description.trim())) throw new Error('description must be a non-empty sentence; the command did not run')
		if (input.timeout !== undefined && (typeof input.timeout !== 'number' || !Number.isFinite(input.timeout) || input.timeout <= 0)) throw new Error(`timeout must be a positive number of seconds, got ${JSON.stringify(input.timeout)}; the command did not run`)
		if (input.background !== undefined && typeof input.background !== 'boolean') throw new Error('background must be a boolean; the command did not run')
		if (input.unsafeToStop !== undefined && typeof input.unsafeToStop !== 'boolean') throw new Error('unsafeToStop must be a boolean; the command did not run')
		let patterns = fileChanges.validate(input.modifies)
		if (ctx.signal.aborted) throw new Error(`${jobs.why(ctx.signal)}; the command did not run`)
		let given = input.timeout === undefined ? undefined : Math.round((input.timeout as number) * 1000)
		let observation = await fileChanges.begin(ctx, patterns)
		let launched = false
		// The call's commits (task 179); a background job finishing after
		// its result has none to give.
		let found: CommitBlock[] = []
		let withCommits = (text: string): ToolOutput => found.length ? { text, commits: found } : text
		let launch = () => {
			if (ctx.signal.aborted) throw new Error(`${jobs.why(ctx.signal)}; the command did not run`)
			let run = jobs.exec(input.command as string, ctx.cwd, given ?? (input.background ? jobs.backgroundMs : 120_000), input.background ? undefined : ctx.onOutput)
			launched = true
			// Lines from commits.committed follow the output (task sg0).
			let done = run.done.then(async (out) => {
				let { lines, commits } = await fileChanges.finish(observation)
				found = commits
				return lines.length ? `${out}${out.endsWith('\n') ? '' : '\n'}\n${lines.join('\n')}` : out
			}, async (e) => { await fileChanges.finish(observation); throw e })
			return { ...run, done }
		}
		try {
			// Escape does not stop a background job. Its snapshot and lock
			// last until actual exit, not until the early tool result.
			if (input.background) return withCommits(await jobs.start(ctx.sessionId, input.command, ctx.cwd, given, ctx.callId, launch, input.unsafeToStop === true ? input : undefined))
			let run = launch()
			let stop = () => run.stop(jobs.why(ctx.signal, 'stopped'))
			ctx.signal.addEventListener('abort', stop, { once: true })
			try { return withCommits(await run.done) } finally { ctx.signal.removeEventListener('abort', stop) }
		} finally {
			if (!launched) observation.release()
		}
	},
}
