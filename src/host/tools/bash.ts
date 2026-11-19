// bash: runs a command in the session's working directory.

import { jobs } from '../jobs.ts'
import { fileChanges } from '../file-changes.ts'
import type { Tool, ToolContext, ToolOutput } from '../tools.ts'
import type { CommitBlock } from '../../common/blocks.ts'

// Configuration: true puts the whole help in the system prompt; false
// lists only the summary under Other tools (HELP <TOOL> shows the rest).
const inPrompt = true
const summary = 'run a shell command'
const help = `## BASH

Use BASH for file discovery (ls, find) and commands. The command goes between !!START and !!END lines.
BASH /* <purpose> */ { timeout?, background?, unsafeToStop?, modifies? }?
!!START
<command>
!!END
	timeout?: number          seconds; default 120, background 600
	background?: boolean      run asynchronously; the result arrives as a message from "bash t<number>"
	unsafeToStop?: boolean    stopping halfway might leave broken state (disk partitioning, database migrations)
	modifies?: string[]       cwd-relative paths/globs it creates, changes or deletes; not .git/ or node_modules/
- Specify modifies if you touch local files. Example:
BASH /* Create files */ { modifies: ["a.txt", "b.txt"] }
!!START
touch {a,b}.txt
!!END
- Avoid pattern "rm -rf $VAR"; "rm -rf /tmp/hal-$session_id-benchmark/" is ok.
- Use /tmp/hal-$session_id- prefix for scratch files.
::: if $session_interactive
- Long-running commands must use background: true, except if they contain 'git commit', which must always run on foreground.
- Start every BASH with a /* purpose */ comment. Start the purpose with a verb such as Find, Change, Fix, or Run.
::: else
- Run commands in the foreground; use background: true only for useful parallel work.
:::
- For background jobs, set timeout and use WAIT for completion instead of polling.`

// unsafeToStop's effect stays unsaid (task ker): steering lets it finish.
const parameters = {
	type: 'object',
	properties: {
		command: { type: 'string' },
		description: { type: 'string' },
		timeout: { type: 'number' },
		background: { type: 'boolean' },
		unsafeToStop: { type: 'boolean' },
		modifies: { type: 'array', items: { type: 'string' } },
	},
	required: ['command'],
}

const syntax = {
	positional: ['command'],
	block: 'command',
	aliases: { cmd: 'command' },
	usage: ['BASH { timeout?, background?, unsafeToStop?, modifies? }?', '!!START', '<command>', '!!END'],
}

async function run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
	if (typeof input.command !== 'string' || !input.command.trim()) throw new Error('command must be a non-empty string')
	if (input.description !== undefined && (typeof input.description !== 'string' || !input.description.trim()))
		throw new Error('description must be a non-empty sentence; the command did not run')
	if (
		input.timeout !== undefined &&
		(typeof input.timeout !== 'number' || !Number.isFinite(input.timeout) || input.timeout <= 0)
	)
		throw new Error(
			`timeout must be a positive number of seconds, got ${JSON.stringify(input.timeout)}; the command did not run`,
		)
	if (input.background !== undefined && typeof input.background !== 'boolean')
		throw new Error('background must be a boolean; the command did not run')
	if (input.unsafeToStop !== undefined && typeof input.unsafeToStop !== 'boolean')
		throw new Error('unsafeToStop must be a boolean; the command did not run')
	let patterns = fileChanges.validate(input.modifies)
	if (ctx.signal.aborted) throw new Error(`${jobs.why(ctx.signal)}; the command did not run`)
	let given = input.timeout === undefined ? undefined : Math.round((input.timeout as number) * 1000)
	let observation = await fileChanges.begin(ctx, patterns)
	if (observation.commits) observation.commits.command = input.command
	let launched = false
	// The call's commits (task 179); a background job finishing after
	// its result has none to give.
	let found: CommitBlock[] = []
	let withCommits = (text: string): ToolOutput => (found.length ? { text, commits: found } : text)
	let launch = () => {
		if (ctx.signal.aborted) throw new Error(`${jobs.why(ctx.signal)}; the command did not run`)
		let run = jobs.exec(
			input.command as string,
			ctx.cwd,
			given ?? (input.background ? jobs.backgroundMs : 120_000),
			ctx.onOutput,
		)
		launched = true
		// Lines from commits.committed follow the output (task sg0).
		let done = run.done.then(
			async (out) => {
				if (observation.commits) observation.commits.output = out
				let { lines, commits } = await fileChanges.finish(observation)
				found = commits
				return lines.length ? `${out}${out.endsWith('\n') ? '' : '\n'}\n${lines.join('\n')}` : out
			},
			async (e) => {
				await fileChanges.finish(observation)
				throw e
			},
		)
		return { ...run, done }
	}
	try {
		// Escape does not stop a background job. Its snapshot and lock
		// last until actual exit, not until the early tool result.
		if (input.background)
			return withCommits(
				await jobs.start(
					ctx.sessionId,
					ctx.callId,
					launch,
					input.unsafeToStop === true ? input : undefined,
					ctx.holdOutput,
				),
			)
		let run = launch()
		let stop = () => run.stop(jobs.why(ctx.signal, 'stopped'))
		ctx.signal.addEventListener('abort', stop, { once: true })
		try {
			return withCommits(await run.done)
		} finally {
			ctx.signal.removeEventListener('abort', stop)
		}
	} finally {
		if (!launched) observation.release()
	}
}

// The command without a leading `cd <cwd> &&`: it runs in cwd anyway,
// and the repeat crowds the call's one-line title.
function withoutCd(command: string, cwd: string): string {
	let m = command.match(/^\s*cd\s+(?:'([^']*)'|"([^"$`\\]*)"|([^\s'"$`\\;&|]+))\s*&&\s*/)
	let dir = m && (m[1] ?? m[2] ?? m[3])!.replace(/(.)\/+$/, '$1')
	return m && dir === cwd.replace(/(.)\/+$/, '$1') ? command.slice(m[0].length) : command
}

export const bash = { withoutCd }

export const tool: Tool<ToolOutput> = {
	name: 'bash',
	inPrompt,
	summary,
	help,
	description: 'Run a command with bash -c in the working directory. Long output is cut.',
	parameters,
	syntax,
	run,
}
