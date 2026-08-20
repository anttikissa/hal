// Bash tool — shell command execution.
//
// Runs commands via bash -lc with configurable timeout, output capture,
// and 1MB output limit with middle-truncation.

import { resolve } from 'path'
import { shellCommand } from '../../utils/shell-command.ts'
import { toolRegistry, type Tool, type ToolContext } from './tool.ts'
import { helpers } from '../../utils/helpers.ts'
import { processOutput } from '../../utils/process-output.ts'
import { sensitive } from './sensitive.ts'
import { ason } from '../../utils/ason.ts'
import { cloc } from '../../utils/cloc.ts'
import { HAL_DIR } from '../state.ts'

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

interface CommitFileStat {
	path: string
	added: number
	removed: number
	locDelta?: number
	isCode?: boolean
}

interface CommitMetadata {
	branch: string
	hash: string
	message: string
	summary: string
	files: CommitFileStat[]
	locDelta?: number
	locDeltaCode?: number
}

const COMMIT_META_START = '[hal-commit]'
const COMMIT_META_END = '[/hal-commit]'

function stripCdCwd(command: string | undefined, cwd: string): string | undefined {
	return shellCommand.stripCdCwd(command, cwd)
}

function hasEscapedCommitMessageNewline(command: string): boolean {
	// Bash passes `\n` in quoted arguments literally. Git would commit those two
	// characters, so require the portable repeated-`-m` form instead.
	return /\bgit\s+commit\b[^;&|]*\s(?:-m|--message)(?:=|\s+)(?:"[^"]*\\n[^"]*"|'[^']*\\n[^']*')/.test(command)
}

function isCommitCommand(command: string): boolean {
	return /\bgit\s+commit\b/.test(command)
}

function isTestPath(path: string): boolean {
	return path.includes('.test.') || path.includes('.spec.') || path.startsWith('test/') || path.startsWith('tests/') || path.includes('/test/') || path.includes('/tests/')
}

function isCodePath(path: string): boolean {
	return /\.[jt]sx?$/.test(path) && !isTestPath(path)
}

function plural(n: number, one: string, many: string): string {
	return n === 1 ? one : many
}

function commitSummary(files: CommitFileStat[]): string {
	let added = 0
	let removed = 0
	for (const file of files) {
		added += file.added
		removed += file.removed
	}
	const parts = [`${files.length} ${plural(files.length, 'file', 'files')} changed`]
	if (added > 0) parts.push(`${added} ${plural(added, 'insertion', 'insertions')}(+)`)
	if (removed > 0) parts.push(`${removed} ${plural(removed, 'deletion', 'deletions')}(-)`)
	return parts.join(', ')
}

function runGit(cwd: string, args: string[]): string {
	const proc = Bun.spawnSync(['git', ...args], {
		cwd,
		stdout: 'pipe',
		stderr: 'ignore',
	})
	if ((proc.exitCode ?? 1) !== 0) return ''
	return new TextDecoder().decode(proc.stdout).trim()
}

function changedFiles(cwd: string, countLoc: boolean): CommitFileStat[] {
	const numstat = runGit(cwd, ['diff-tree', '--root', '--no-commit-id', '--numstat', '-r', 'HEAD'])
	const patch = countLoc ? runGit(cwd, ['show', '--format=', '--unified=0', '--no-ext-diff', 'HEAD']) : ''
	const changes = changedPatchLines(patch)
	const files: CommitFileStat[] = []
	for (const line of numstat.split('\n')) {
		if (!line.trim()) continue
		const parts = line.split('\t')
		const added = Number(parts[0])
		const removed = Number(parts[1])
		const path = parts.at(-1) ?? ''
		const file: CommitFileStat = {
			path,
			added: Number.isFinite(added) ? added : 0,
			removed: Number.isFinite(removed) ? removed : 0,
		}
		if (countLoc) {
			const locAdded = cloc.countText((changes.added.get(path) ?? []).join('\n'))
			const locRemoved = cloc.countText((changes.removed.get(path) ?? []).join('\n'))
			file.locDelta = locAdded - locRemoved
			file.isCode = isCodePath(path)
		}
		files.push(file)
	}
	return files
}

function changedPatchLines(patch: string): { added: Map<string, string[]>; removed: Map<string, string[]> } {
	const added = new Map<string, string[]>()
	const removed = new Map<string, string[]>()
	let path = ''
	for (const line of patch.split('\n')) {
		if (line.startsWith('--- a/') || line.startsWith('+++ b/')) {
			path = line.slice(6)
			if (!added.has(path)) added.set(path, [])
			if (!removed.has(path)) removed.set(path, [])
			continue
		}
		if (!path || line.startsWith('+++') || line.startsWith('---')) continue
		if (line.startsWith('+')) added.get(path)!.push(line.slice(1))
		if (line.startsWith('-')) removed.get(path)!.push(line.slice(1))
	}
	return { added, removed }
}


function commitMetadata(cwd: string): CommitMetadata | null {
	const hash = runGit(cwd, ['show', '-s', '--format=%h', 'HEAD'])
	if (!hash) return null
	const branch = runGit(cwd, ['branch', '--show-current']) || 'HEAD'
	const message = runGit(cwd, ['show', '-s', '--format=%B', 'HEAD'])
	// LOC counting knows only this repo's languages, comment syntax, and budget.
	const countLoc = resolve(runGit(cwd, ['rev-parse', '--show-toplevel'])) === resolve(HAL_DIR)
	const files = changedFiles(cwd, countLoc)
	const meta: CommitMetadata = { branch, hash, message, summary: commitSummary(files), files }
	if (!countLoc) return meta
	let locDelta = 0
	let locDeltaCode = 0
	for (const file of files) {
		locDelta += file.locDelta ?? 0
		if (file.isCode) locDeltaCode += file.locDelta ?? 0
	}
	return { ...meta, locDelta, locDeltaCode }
}

function appendCommitMetadata(out: string, command: string, cwd: string, code: number): string {
	if (code !== 0 || !isCommitCommand(command)) return out
	const meta = commitMetadata(cwd)
	if (!meta) return out
	return `${out}\n${COMMIT_META_START}\n${ason.stringify(meta, 'long')}\n${COMMIT_META_END}`
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

/** Kill a detached process group, including jobs whose shell has already exited. */
function killProcessTree(rootPid: number, signal: 'SIGTERM' | 'SIGKILL'): void {
	try {
		// A negative PID targets the POSIX process group whose leader is rootPid.
		process.kill(-rootPid, signal)
		return
	} catch {}
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
	if (hasEscapedCommitMessageNewline(command)) return 'error: git commit message contains literal \\n; use separate -m options for paragraphs'
	if (!ctx.approvedRisk && sensitive.commandMentionsProtectedPath(command)) return 'error: refusing to run command that mentions protected credentials file'

	const timeout = spec.timeout ?? config.defaultTimeout

	const proc = Bun.spawn(['bash', '-lc', command], {
		// Isolate commands so abort can signal background jobs after bash itself exits.
		detached: true,
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
	let streamedStdout = ''
	let streamedStderr = ''
	function reportOutput(): void {
		let output = streamedStdout
		if (streamedStderr) output += (output ? '\n' : '') + streamedStderr
		ctx.onOutput?.(output)
	}
	const stdoutPromise = processOutput.readLimited(proc.stdout, config.maxOutputBytes, '\n[… truncated]', undefined, (text) => {
		streamedStdout += text
		reportOutput()
	})
	const stderrPromise = processOutput.readLimited(proc.stderr, config.maxOutputBytes, '\n[… truncated]', undefined, (text) => {
		streamedStderr += text
		reportOutput()
	})
	const [stdout, stderrResult, code] = await Promise.all([stdoutPromise, stderrPromise, proc.exited])
	let out = stdout.text
	const stderr = stderrResult.text

	clearTimeout(timer)
	abortCleanup?.()

	// Build output string
	if (ctx.signal?.aborted) {
		if (stderr) out += (out && !out.endsWith('\n') ? '\n' : '') + stderr
		if (out && !out.endsWith('\n')) out += '\n'
		return truncateOutput(out + '[interrupted]')
	}
	if (stderr) out += (out ? '\n' : '') + stderr
	if (code !== 0) out += `\n[exit ${code}]`
	out = appendCommitMetadata(out, command, ctx.cwd, code)

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
