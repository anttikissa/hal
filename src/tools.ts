import { $ } from 'bun'
import { readFile, writeFile, appendFile, mkdir, stat } from 'fs/promises'
import { isAbsolute, resolve } from 'path'
import { hashLine, applyEdit, applyInsert } from './hashline.ts'
import { randomBytes } from 'crypto'
import { homedir } from 'os'
import { stringify } from './utils/ason.ts'
import { TOOL_LOG } from './state.ts'
import { debugEnabled } from './config.ts'
import { logSnapshot, getDebugLogPath } from './debug-log.ts'

const HOME = homedir()
export function shortenHome(text: string): string {
	if (!HOME) return text
	return text.replaceAll(HOME, '~')
}

/** Preview content: show up to 3 lines, omit rest with (+N lines) */
function contentPreview(text: string): string {
	const lines = text.split('\n')
	const show = lines.slice(0, 3)
	const rest = lines.length - show.length
	const suffix = rest > 0 ? `\n(+${rest} lines)` : ''
	return show.join('\n') + suffix
}

/** Cap output for TUI display: show head + tail with omission note */
function displayPreview(text: string, maxLines = MAX_DISPLAY_LINES): string {
	const lines = text
		.split('\n')
		.map((line) =>
			line.length > MAX_LINE_LEN ? line.slice(0, MAX_LINE_LEN) + '… [line truncated]' : line,
		)
	if (lines.length <= maxLines) return lines.join('\n')
	const headCount = Math.ceil(maxLines / 2)
	const tailCount = maxLines - headCount
	const omitted = lines.length - headCount - tailCount
	return [
		...lines.slice(0, headCount),
		`[${omitted} lines omitted]`,
		...lines.slice(-tailCount),
	].join('\n')
}

const MAX_LINES = 2000
const MAX_BYTES = 50 * 1024
const MAX_LINE_LEN = 2000
const MAX_DISPLAY_LINES = 15 // max lines shown in TUI scroll buffer
const TOOL_OUTPUT_DIR = '/tmp/hal/tool-output'

async function truncateOutput(
	output: string,
	mode: 'tail' | 'head',
): Promise<{ text: string; truncated: boolean; fullPath?: string }> {
	const bytes = Buffer.byteLength(output)
	const lines = output.split('\n')
	const capped = lines.map((line) =>
		line.length > MAX_LINE_LEN ? line.slice(0, MAX_LINE_LEN) + '… [line truncated]' : line,
	)
	if (capped.length <= MAX_LINES && bytes <= MAX_BYTES) {
		return { text: capped.join('\n'), truncated: false }
	}

	await mkdir(TOOL_OUTPUT_DIR, { recursive: true })
	const id = randomBytes(6).toString('hex')
	const fullPath = `${TOOL_OUTPUT_DIR}/${id}.txt`
	await writeFile(fullPath, output)

	let kept: string[]
	if (mode === 'tail') {
		kept = capped.slice(-MAX_LINES)
		let total = 0,
			start = kept.length
		for (let i = kept.length - 1; i >= 0; i--) {
			total += Buffer.byteLength(kept[i]) + 1
			if (total > MAX_BYTES) {
				start = i + 1
				break
			}
			start = i
		}
		kept = kept.slice(start)
	} else {
		kept = capped.slice(0, MAX_LINES)
		let total = 0,
			end = 0
		for (let i = 0; i < kept.length; i++) {
			total += Buffer.byteLength(kept[i]) + 1
			if (total > MAX_BYTES) break
			end = i + 1
		}
		kept = kept.slice(0, end)
	}

	const hint = `Use grep to search or read with start/end to view specific sections.`
	const prefix =
		mode === 'tail'
			? `[${lines.length - kept.length} lines truncated — showing last ${kept.length}/${lines.length} lines]\n[Full output: ${fullPath}]\n${hint}\n\n`
			: `[Showing first ${kept.length}/${lines.length} lines — ${lines.length - kept.length} lines truncated]\n[Full output: ${fullPath}]\n${hint}\n\n`
	return { text: prefix + kept.join('\n'), truncated: true, fullPath }
}

const ERROR_PATTERNS = [
	/no such file or directory/i,
	/command not found/i,
	/permission denied/i,
	/cannot access/i,
	/not found/i,
	/fatal:/i,
	/error:/i,
	/failed to/i,
	/segmentation fault/i,
]
function looksLikeError(stderr: string): boolean {
	return ERROR_PATTERNS.some((p) => p.test(stderr))
}

export const tools = [
	{
		name: 'bash',
		description: 'Run a bash command',
		input_schema: {
			type: 'object',
			properties: { command: { type: 'string' } },
			required: ['command'],
		},
	},
	{
		name: 'read',
		description:
			'Read a file with hashline prefixes (LINE:HASH content). Use optional start/end to read a line range.',
		input_schema: {
			type: 'object',
			properties: {
				path: { type: 'string' },
				start: { type: 'integer', description: 'First line number (1-based, inclusive)' },
				end: { type: 'integer', description: 'Last line number (inclusive)' },
			},
			required: ['path'],
		},
	},
	{
		name: 'write',
		description: 'Create or overwrite a file with full content (no hashline prefixes).',
		input_schema: {
			type: 'object',
			properties: { path: { type: 'string' }, content: { type: 'string' } },
			required: ['path', 'content'],
		},
	},
	{
		name: 'edit',
		description: `Edit a file using hashline refs from read. Hashes are verified; mismatch = re-read needed.
- replace: replace start_ref..end_ref (inclusive) with new_content. Same ref for single line. Empty new_content to delete.
- insert: insert new_content after after_ref. Use "0:000" for beginning of file.
new_content is raw file content \u2014 no hashline prefixes. A trailing newline in new_content is stripped (each line in the file already has one).`,
		input_schema: {
			type: 'object',
			properties: {
				path: { type: 'string' },
				operation: { type: 'string', enum: ['replace', 'insert'] },
				start_ref: { type: 'string', description: 'LINE:HASH of first line to replace' },
				end_ref: { type: 'string', description: 'LINE:HASH of last line to replace' },
				after_ref: {
					type: 'string',
					description: "LINE:HASH to insert after (or '0:000' for start)",
				},
				new_content: {
					type: 'string',
					description: 'Replacement text (raw, no hashline prefixes)',
				},
			},
			required: ['path', 'operation', 'new_content'],
		},
		cache_control: { type: 'ephemeral' },
	},
	{
		name: 'grep',
		description:
			'Search file contents using ripgrep. Returns matching lines with file paths and line numbers.',
		input_schema: {
			type: 'object',
			properties: {
				pattern: { type: 'string', description: 'Search pattern (regex)' },
				path: { type: 'string', description: 'Directory or file to search (default: cwd)' },
				include: {
					type: 'string',
					description: "Glob pattern to filter files, e.g. '*.ts'",
				},
			},
			required: ['pattern'],
		},
	},
	{
		name: 'glob',
		description:
			'Find files by glob pattern. Returns matching file paths sorted by modification time.',
		input_schema: {
			type: 'object',
			properties: {
				pattern: {
					type: 'string',
					description: "Glob pattern, e.g. '*.ts', 'src/**/*.tsx'",
				},
				path: { type: 'string', description: 'Directory to search in (default: cwd)' },
			},
			required: ['pattern'],
		},
	},
	{
		name: 'ls',
		description: 'List directory contents as a tree. Ignores node_modules, .git, dist, etc.',
		input_schema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Directory to list (default: cwd)' },
				depth: { type: 'integer', description: 'Max depth (default: 3)' },
			},
		},
	},
	{
		type: 'web_search_20250305',
		name: 'web_search',
		max_uses: 5,
	},
	{
		name: 'snapshot',
		description:
			'Capture a debug snapshot of the terminal output. Returns the current terminal transcript for self-debugging UI issues.',
		input_schema: { type: 'object', properties: {} },
	},
	{
		name: 'restart',
		description: 'Restart the HAL process. Session is saved and restored on restart.',
		input_schema: { type: 'object', properties: {} },
	},
]

export const RESTART_SIGNAL = '__HAL_RESTART__'

type ToolLogLevel = 'info' | 'warn' | 'error' | 'tool' | 'meta'
type ToolLogger = (line: string, level?: ToolLogLevel) => void | Promise<void>

function resolveToolPath(cwd: string, maybePath?: string): string {
	if (!maybePath || !maybePath.trim()) return cwd
	return isAbsolute(maybePath) ? maybePath : resolve(cwd, maybePath)
}

async function logToolCall(
	name: string,
	input: any,
	output: string,
	durationMs: number,
	ok: boolean,
): Promise<void> {
	if (!debugEnabled('toolCalls')) return
	try {
		const entry = {
			ts: new Date().toISOString(),
			tool: name,
			input,
			output: output.length > 500 ? output.slice(0, 500) + '...' : output,
			durationMs,
			ok,
		}
		await appendFile(TOOL_LOG, stringify(entry, 'short') + '\n')
	} catch {}
}

export async function runTool(
	name: string,
	input: any,
	options: { logger?: ToolLogger; cwd?: string; signal?: AbortSignal } = {},
): Promise<string> {
	const logger: ToolLogger = options.logger ?? ((line) => console.log(line))
	const cwd = resolve(options.cwd ?? process.cwd())
	const start = Date.now()
	try {
		const result = await _runTool(name, input, logger, cwd, options.signal)
		await logToolCall(name, input, result, Date.now() - start, true)
		return result
	} catch (e: any) {
		const msg = `error: ${e.message || e}`
		await logger(msg, 'error')
		await logToolCall(name, input, msg, Date.now() - start, false)
		return msg
	}
}

async function _runTool(
	name: string,
	input: any,
	logger: ToolLogger,
	cwd: string,
	signal?: AbortSignal,
): Promise<string> {
	if (name === 'bash') {
		let command = String(input.command ?? '')
		const cdMatch = command.match(/^cd\s+(\S+)\s*&&\s*/)
		if (cdMatch) {
			const cdTarget = resolve(cwd, cdMatch[1])
			if (cdTarget === cwd) command = command.slice(cdMatch[0].length)
		}
		await logger(shortenHome(`[bash] ${command}`), 'tool')
		const proc = Bun.spawn(['bash', '-lc', command], { cwd, stdout: 'pipe', stderr: 'pipe' })

		// Kill subprocess when paused/aborted
		if (signal) {
			const onAbort = () => {
				try {
					proc.kill('SIGTERM')
				} catch {}
			}
			if (signal.aborted) onAbort()
			else signal.addEventListener('abort', onAbort, { once: true })
		}

		// Stream stdout with progress heartbeats for long-running commands
		const stdoutChunks: string[] = []
		let lineCount = 0
		let lastHeartbeatLines = 0
		let lastHeartbeatTime = Date.now()
		const HEARTBEAT_MS = 2000 // emit progress at most every 2s
		const HEARTBEAT_MIN_LINES = 10 // only emit if meaningful output accumulated
		const decoder = new TextDecoder()
		let partial = ''
		let firstLine: string | null = null

		const reader = proc.stdout.getReader()
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			const chunk = decoder.decode(value, { stream: true })
			stdoutChunks.push(chunk)
			partial += chunk
			const lines = partial.split('\n')
			partial = lines.pop()! // keep incomplete last line
			if (!firstLine && lines.length > 0) firstLine = lines[0]
			lineCount += lines.length

			const now = Date.now()
			const newLines = lineCount - lastHeartbeatLines
			if (newLines >= HEARTBEAT_MIN_LINES && now - lastHeartbeatTime >= HEARTBEAT_MS) {
				if (lastHeartbeatLines === 0 && firstLine) {
					await logger(firstLine, 'tool')
				}
				await logger(`[+ ${newLines} lines, total ${lineCount}]`, 'tool')
				lastHeartbeatLines = lineCount
				lastHeartbeatTime = now
			}
		}
		if (partial) lineCount += 1 // count trailing partial line

		const stdout = stdoutChunks.join('')
		const stderr = await new Response(proc.stderr).text()
		const exitCode = await proc.exited

		if (signal?.aborted) return stdout + stderr + '\n[interrupted]'

		const stderrWarn =
			exitCode === 0 && stderr && looksLikeError(stderr)
				? '[warn: possible error despite exit 0 — check stderr above]\n'
				: ''
		const exitNote = exitCode === 0 ? '' : `\n[exit ${exitCode}]`
		const raw = stdout + stderr + exitNote
		const output = stderrWarn + raw
		const { text, truncated, fullPath } = await truncateOutput(output, 'tail')
		if (truncated) {
			await logger(shortenHome(`[truncated -> ${fullPath}]`), 'warn')
			const preview = displayPreview(raw.split('\n').slice(-50).join('\n'))
			if (preview) await logger(preview, 'tool')
		} else {
			if (raw) await logger(displayPreview(raw), 'tool')
		}
		return text || '(empty)'
	}

	if (name === 'read') {
		if (typeof input?.path !== 'string' || !input.path.trim())
			return 'error: read requires path'
		const path = resolveToolPath(cwd, input.path)
		const info = await stat(path)
		if (info.isDirectory()) return `error: ${path} is a directory, not a file. Use the ls tool to list directory contents.`
		const content = await readFile(path, 'utf-8')
		const lines = content.split('\n')
		const total = lines.length
		const s = Math.max(1, input.start ?? 1)
		const e = Math.min(total, input.end ?? total)
		const slice = lines.slice(s - 1, e)
		const width = String(e).length
		const formatted = slice
			.map((line, i) => {
				const num = String(s + i).padStart(width)
				return `${num}:${hashLine(line)} ${line}`
			})
			.join('\n')
		const { text, truncated, fullPath } = await truncateOutput(formatted, 'head')
		const range = s > 1 || e < total ? ` [${s}-${e}/${total}]` : ''
		const truncNote = truncated ? ` (truncated → ${fullPath})` : ''
		await logger(shortenHome(`[read] ${path}${range}${truncNote}`), 'tool')
		const previewLimit = 8
		const previewLines = slice.slice(0, previewLimit)
		const omitted = Math.max(0, slice.length - previewLines.length)
		if (previewLines.length > 0) {
			const suffix = omitted > 0 ? `\n[${omitted} more lines not shown]` : ''
			await logger(`${previewLines.join('\n')}${suffix}`, 'tool')
		}
		return text
	}

	if (name === 'write') {
		if (typeof input?.path !== 'string' || !input.path.trim())
			return 'error: write requires path'
		if (typeof input?.content !== 'string') return 'error: write requires content'
		const path = resolveToolPath(cwd, input.path)
		try {
			const info = await stat(path)
			if (info.isDirectory()) return `error: ${path} is a directory, not a file`
		} catch {
			// Path doesn't exist yet — that's fine for write
		}
		const content = input.content
		await logger(shortenHome(`[write] ${path} (${content.length} chars)`), 'tool')
		await writeFile(path, content)
		return 'ok'
	}

	if (name === 'edit') {
		if (typeof input?.path !== 'string' || !input.path.trim())
			return 'error: edit requires path'
		if (input.operation !== 'replace' && input.operation !== 'insert')
			return `error: unknown operation "${input.operation}"`
		if (typeof input.new_content !== 'string')
			return 'error: edit requires new_content'
		const path = resolveToolPath(cwd, input.path)
		const content = await readFile(path, 'utf-8')
		let result: { result?: string; error?: string }
		if (input.operation === 'replace') {
			if (!input.start_ref || !input.end_ref)
				return 'error: replace requires start_ref and end_ref'
			await logger(
				shortenHome(`[edit] ${path} replace ${input.start_ref}..${input.end_ref}`),
				'tool',
			)
			result = applyEdit(content, input.start_ref, input.end_ref, input.new_content)
		} else {
			if (!input.after_ref) return 'error: insert requires after_ref'
			await logger(shortenHome(`[edit] ${path} insert after ${input.after_ref}`), 'tool')
			result = applyInsert(content, input.after_ref, input.new_content)
		}
		if (result.error)
			return `error: ${result.error}\n\nRe-read the file to get updated LINE:HASH references.`
		await writeFile(path, result.result!)
		return 'ok'
	}

	if (name === 'grep') {
		const pattern = input.pattern
		const searchPath = resolveToolPath(cwd, input.path)
		const args = [
			'rg',
			'-nH',
			'--no-heading',
			'--color=never',
			'--hidden',
			'--max-count=100',
			'--sort=modified',
		]
		if (input.include) args.push('--glob', input.include)
		args.push('--', pattern, searchPath)
		await logger(
			shortenHome(
				`[grep] "${pattern}" in ${searchPath}${input.include ? ` (${input.include})` : ''}`,
			),
			'tool',
		)
		const result = await $`${args}`.quiet().nothrow()
		const raw = result.stdout.toString()
		if (!raw.trim()) {
			await logger('(no matches)', 'tool')
			return 'No matches found.'
		}
		const lines = raw.split('\n').filter((l) => l)
		const MAX_GREP = 100
		const capped = lines
			.slice(0, MAX_GREP)
			.map((line) => (line.length > 500 ? line.slice(0, 500) + '… [truncated]' : line))
		let output = capped.join('\n')
		if (lines.length > MAX_GREP)
			output += `\n\n[Showing ${MAX_GREP}/${lines.length} matches. Narrow your search.]`
		const { text, truncated } = await truncateOutput(output, 'head')
		if (truncated) await logger('[grep output truncated]', 'warn')
		await logger(`${lines.length} match${lines.length === 1 ? '' : 'es'}`, 'tool')
		return text
	}

	if (name === 'glob') {
		const pattern = input.pattern
		const searchPath = resolveToolPath(cwd, input.path)
		const args = ['rg', '--files', '--hidden', '--sort=modified', '--glob', pattern, searchPath]
		await logger(shortenHome(`[glob] ${pattern} in ${searchPath}`), 'tool')
		const result = await $`${args}`.quiet().nothrow()
		const raw = result.stdout.toString()
		if (!raw.trim()) {
			await logger('(no files found)', 'tool')
			return 'No files found.'
		}
		const files = raw.split('\n').filter((l) => l)
		const MAX_FILES = 200
		let output = files.slice(0, MAX_FILES).join('\n')
		if (files.length > MAX_FILES)
			output += `\n\n[Showing ${MAX_FILES}/${files.length} files. Narrow your pattern.]`
		await logger(`${files.length} file${files.length === 1 ? '' : 's'}`, 'tool')
		return output
	}

	if (name === 'ls') {
		const dir = resolveToolPath(cwd, input.path)
		const maxDepth = input.depth ?? 3
		await logger(shortenHome(`[ls] ${dir} (depth=${maxDepth})`), 'tool')
		const IGNORE = new Set([
			'node_modules',
			'.git',
			'dist',
			'build',
			'.next',
			'__pycache__',
			'.cache',
			'.venv',
			'venv',
			'coverage',
			'.turbo',
			'target',
			'.idea',
			'.vscode',
		])
		const MAX_ENTRIES = 500
		let count = 0
		async function tree(dirPath: string, prefix: string, depth: number): Promise<string[]> {
			if (depth > maxDepth || count > MAX_ENTRIES) return []
			const { readdir, stat } = await import('fs/promises')
			let entries: string[]
			try {
				entries = await readdir(dirPath)
			} catch {
				return [`${prefix}[permission denied]`]
			}
			entries.sort()
			const lines: string[] = []
			for (const entry of entries) {
				if (IGNORE.has(entry)) continue
				if (count > MAX_ENTRIES) {
					lines.push(`${prefix}... (truncated)`)
					break
				}
				count++
				const fullPath = `${dirPath}/${entry}`
				try {
					const s = await stat(fullPath)
					if (s.isDirectory()) {
						lines.push(`${prefix}${entry}/`)
						lines.push(...(await tree(fullPath, prefix + '  ', depth + 1)))
					} else {
						lines.push(`${prefix}${entry}`)
					}
				} catch {
					lines.push(`${prefix}${entry} [error]`)
				}
			}
			return lines
		}
		const lines = await tree(dir, '', 0)
		if (lines.length === 0) return '(empty directory)'
		const preview = lines.slice(0, 5).join('\n')
		const more = lines.length > 5 ? `\n  ... (${lines.length - 5} more)` : ''
		await logger(`${count} entries\n${preview}${more}`, 'tool')
		return lines.join('\n')
	}

	if (name === 'snapshot') {
		await logger('[snapshot] capturing debug snapshot', 'tool')
		// Read the tail of the events log — this is what's been rendered on screen
		const { IPC_DIR } = await import('./state.ts')
		const eventsPath = `${IPC_DIR}/events.ason`
		try {
			const content = await readFile(eventsPath, 'utf-8')
			const lines = content.trim().split('\n')
			const tail = lines.slice(-200).join('\n')
			logSnapshot(tail)
			const path = getDebugLogPath()
			await logger(`[snapshot] saved to ${path}`, 'tool')
			return `Snapshot saved to ${path}. Last ${Math.min(200, lines.length)} events captured.`
		} catch (e: any) {
			return `error: ${e.message}`
		}
	}

	if (name === 'restart') {
		await logger('[restart] restarting...', 'warn')
		return RESTART_SIGNAL
	}

	return 'unknown tool'
}
