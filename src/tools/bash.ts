// Bash tool — shell command execution.
//
// Runs commands via bash -lc with configurable timeout, output capture,
// and 1MB output limit with middle-truncation.

import { resolve } from 'path'
import { homedir } from 'os'
import { toolRegistry, type Tool, type ToolContext } from './tool.ts'
import { helpers } from '../utils/helpers.ts'
import { processOutput } from '../utils/process-output.ts'
import { sensitive } from './sensitive.ts'

const config = {
	/** Default timeout in milliseconds. */
	defaultTimeout: 120_000,
	/** Maximum output size in bytes before truncation. */
	maxOutputBytes: 1_000_000,
}

interface BashInput {
	command?: string
	timeout?: number
}

type TimerWithUnref = ReturnType<typeof setTimeout> & { unref?: () => void }

const HOME = homedir()

function shellPath(text: string, cwd: string): string {
	let path = text.replace(/^['"]|['"]$/g, '')
	if (path === '~') path = HOME
	if (path.startsWith('~/')) path = HOME + path.slice(1)
	return resolve(cwd, path)
}

function stripCdCwd(command: string | undefined, cwd: string): string | undefined {
	const match = command?.match(/^cd\s+(.+?)\s*&&\s*/)
	if (!match) return command
	const target = shellPath(match[1]!, cwd)
	return target === resolve(cwd) ? command!.slice(match[0].length) : command
}

function normalizeInput(input: unknown, cwd: string): BashInput {
	const raw = toolRegistry.inputObject(input)
	const timeout = Number(raw.timeout)
	const command = typeof raw.command === 'string' ? raw.command : raw.command === undefined ? undefined : String(raw.command)
	return {
		command: stripCdCwd(command, cwd),
		timeout: Number.isFinite(timeout) ? timeout : undefined,
	}
}

// ── Process tree management ──

/** Get child PIDs of a process (non-recursive). */
function childPids(parentPid: number): number[] {
	const result = Bun.spawnSync(['pgrep', '-P', String(parentPid)], {
		stdout: 'pipe',
		stderr: 'ignore',
	})
	if (result.exitCode !== 0) return []
	const text = new TextDecoder().decode(result.stdout).trim()
	if (!text) return []
	return text
		.split(/\s+/)
		.map(Number)
		.filter((pid) => Number.isInteger(pid) && pid > 0)
}

/** Recursively kill a process tree. */
function killProcessTree(rootPid: number, signal: 'SIGTERM' | 'SIGKILL'): void {
	for (const pid of childPids(rootPid)) killProcessTree(pid, signal)
	try {
		process.kill(rootPid, signal)
	} catch {}
}

// ── Output truncation ──

function truncateOutput(text: string): string {
	return helpers.truncateUtf8(text, config.maxOutputBytes, '\n[… truncated]')
}

// ── Execution ──

async function execute(input: unknown, ctx: ToolContext): Promise<string> {
	const spec = normalizeInput(input, ctx.cwd)
	const command = spec.command ?? ''
	if (!command.trim()) return 'error: empty command'
	if (sensitive.commandMentionsProtectedPath(command)) return 'error: refusing to run command that mentions protected credentials file'

	const timeout = spec.timeout ?? config.defaultTimeout

	const proc = Bun.spawn(['bash', '-lc', command], {
		cwd: ctx.cwd,
		stdout: 'pipe',
		stderr: 'pipe',
		env: { ...process.env, TERM: 'dumb' },
	})

	// Kill the full process tree on abort (SIGTERM, then SIGKILL after 2s)
	let abortCleanup: (() => void) | undefined
	if (ctx.signal) {
		const onAbort = () => {
			killProcessTree(proc.pid, 'SIGTERM')
			const timer: TimerWithUnref = setTimeout(() => killProcessTree(proc.pid, 'SIGKILL'), 2000)
			timer.unref?.()
		}
		if (ctx.signal.aborted) {
			onAbort()
		} else {
			ctx.signal.addEventListener('abort', onAbort, { once: true })
			abortCleanup = () => ctx.signal!.removeEventListener('abort', onAbort)
		}
	}

	// Set up timeout: kill process tree after timeout ms
	const timer = setTimeout(() => {
		killProcessTree(proc.pid, 'SIGTERM')
		setTimeout(() => killProcessTree(proc.pid, 'SIGKILL'), 2000)
	}, timeout)

	// Read streams with caps while continuing to drain after the cap. This keeps
	// memory bounded even for noisy long-running commands.
	const stdoutPromise = processOutput.readLimited(proc.stdout, config.maxOutputBytes, '\n[… truncated]')
	const stderrPromise = processOutput.readLimited(proc.stderr, config.maxOutputBytes, '\n[… truncated]')
	const [stdout, stderrResult, code] = await Promise.all([stdoutPromise, stderrPromise, proc.exited])
	let out = stdout.text
	const stderr = stderrResult.text

	clearTimeout(timer)
	abortCleanup?.()

	// Build output string
	if (ctx.signal?.aborted) {
		return truncateOutput(out + (stderr ? '\n' + stderr : '') + '\n[interrupted]')
	}
	if (stderr) out += (out ? '\n' : '') + stderr
	if (code !== 0) out += `\n[exit ${code}]`

	return truncateOutput(out || '(no output)')
}

// ── Registration ──

const bashTool: Tool = {
	name: 'bash',
	description: 'Run a bash command. Output is captured and returned.',
	parameters: {
		command: { type: 'string', description: 'The bash command to execute' },
		timeout: { type: 'integer', description: 'Timeout in ms (default: 120000)' },
	},
	required: ['command'],
	execute,
}

function init(): void {
	toolRegistry.registerTool(bashTool)
}

export const bash = { config, stripCdCwd, killProcessTree, execute, init }
