// Tools — definitions + execution for the agent loop.
// Hashline (read/edit), bash, write, grep, glob, ls, web_search.

import { createHash } from 'crypto'
import { readFileSync, statSync, readdirSync } from 'fs'
import { resolve, isAbsolute } from 'path'
import { $ } from 'bun'
import { homedir } from 'os'
import { stringify } from '../utils/ason.ts'

const HOME = homedir()
const CWD = process.env.LAUNCH_CWD ?? process.cwd()
const MAX_OUTPUT = 50_000

function resolvePath(p?: string): string {
	if (!p?.trim()) return CWD
	if (p.startsWith('~/')) p = HOME + p.slice(1)
	return isAbsolute(p) ? p : resolve(CWD, p)
}

function truncate(s: string, max = MAX_OUTPUT): string {
	if (s.length <= max) return s
	return s.slice(0, max) + `\n[truncated ${s.length - max} chars]`
}

// ── Hashline ──

const ALPHA = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
const BASE = ALPHA.length

function hashLine(line: string): string {
	const norm = line.trim().replace(/\s+/g, ' ')
	const md5 = createHash('md5').update(norm).digest()
	const n = (md5[0] << 16) | (md5[1] << 8) | md5[2]
	return ALPHA[n % BASE] + ALPHA[Math.floor(n / BASE) % BASE] + ALPHA[Math.floor(n / (BASE * BASE)) % BASE]
}

function formatHashlines(content: string, start = 1, end?: number): string {
	const lines = content.split('\n')
	const s = Math.max(1, start), e = Math.min(lines.length, end ?? lines.length)
	const w = String(e).length
	return lines.slice(s - 1, e)
		.map((line, i) => `${String(s + i).padStart(w)}:${hashLine(line)} ${line}`)
		.join('\n')
}

function parseRef(ref: string): { line: number; hash: string } | null {
	const m = ref.match(/^(\d+):([0-9a-zA-Z]{3})$/)
	return m ? { line: parseInt(m[1], 10), hash: m[2] } : null
}

function validateRef(ref: { line: number; hash: string }, lines: string[]): string | null {
	if (ref.line < 1 || ref.line > lines.length)
		return `Line ${ref.line} out of range (file has ${lines.length} lines)`
	const actual = hashLine(lines[ref.line - 1])
	if (actual !== ref.hash)
		return `Hash mismatch at line ${ref.line}: expected ${ref.hash}, got ${actual} (content: ${stringify(lines[ref.line - 1].slice(0, 60))})`
	return null
}

const CTX = 3
function contextLines(lines: string[], start: number, end: number): string {
	const from = Math.max(0, start - CTX), to = Math.min(lines.length, end + CTX)
	const w = String(to).length
	return lines.slice(from, to).map((line, i) =>
		`${String(from + i + 1).padStart(w)}:${hashLine(line)} ${line}`
	).join('\n')
}

function applyEdit(content: string, startRef: string, endRef: string, newContent: string): string {
	const start = parseRef(startRef), end = parseRef(endRef)
	if (!start) return `error: invalid start ref: ${startRef}`
	if (!end) return `error: invalid end ref: ${endRef}`
	const lines = content.split('\n')
	const e1 = validateRef(start, lines), e2 = validateRef(end, lines)
	if (e1) return `error: ${e1}\n\nRe-read the file to get updated LINE:HASH references.`
	if (e2) return `error: ${e2}\n\nRe-read the file to get updated LINE:HASH references.`
	if (start.line > end.line) return `error: start ${start.line} > end ${end.line}`
	const before = contextLines(lines, start.line - 1, end.line)
	newContent = newContent.replace(/\n$/, '')
	const newLines = newContent === '' ? [] : newContent.split('\n')
	const result = [...lines.slice(0, start.line - 1), ...newLines, ...lines.slice(end.line)]
	const after = contextLines(result, start.line - 1, start.line - 1 + newLines.length)
	Bun.write(resolvePath(startRef.split(':')[0] ? undefined : undefined), result.join('\n')) // not used — caller writes
	return `--- before\n${before}\n\n+++ after\n${after}`
}

function applyInsert(content: string, afterRef: string, newContent: string): string {
	const lines = content.split('\n')
	newContent = newContent.replace(/\n$/, '')
	const newLines = newContent.split('\n')
	let insertAt: number
	if (afterRef === '0:000') {
		insertAt = 0
	} else {
		const ref = parseRef(afterRef)
		if (!ref) return `error: invalid ref: ${afterRef}`
		const err = validateRef(ref, lines)
		if (err) return `error: ${err}\n\nRe-read the file to get updated LINE:HASH references.`
		insertAt = ref.line
	}
	const before = contextLines(lines, insertAt, insertAt)
	const result = [...lines.slice(0, insertAt), ...newLines, ...lines.slice(insertAt)]
	const after = contextLines(result, insertAt, insertAt + newLines.length)
	return `--- before\n${before}\n\n+++ after\n${after}`
}

// ── File lock ──

const locks = new Map<string, Promise<void>>()
function withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
	const prev = locks.get(path) ?? Promise.resolve()
	const result = prev.then(fn, fn)
	const done = result.then(() => {}, () => {})
	locks.set(path, done)
	done.then(() => { if (locks.get(path) === done) locks.delete(path) })
	return result
}

// ── Tool definitions ──

export const TOOLS = [
	{ name: 'bash', description: 'Run a bash command',
		input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
	{ name: 'read', description: 'Read a file with hashline prefixes (LINE:HASH content). Use optional start/end to read a line range.',
		input_schema: { type: 'object', properties: {
			path: { type: 'string' }, start: { description: 'First line number (1-based, inclusive)', type: 'integer' },
			end: { description: 'Last line number (inclusive)', type: 'integer' } }, required: ['path'] } },
	{ name: 'write', description: 'Create or overwrite a file with full content (no hashline prefixes).',
		input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
	{ name: 'edit', description: `Edit a file using hashline refs from read. Hashes are verified; mismatch = re-read needed.
- replace: replace start_ref..end_ref (inclusive) with new_content. Same ref for single line. Empty new_content to delete.
- insert: insert new_content after after_ref. Use "0:000" for beginning of file.
new_content is raw file content \u2014 no hashline prefixes. A trailing newline in new_content is stripped (each line in the file already has one).`,
		input_schema: { type: 'object', properties: {
			path: { type: 'string' }, operation: { type: 'string', enum: ['replace', 'insert'] },
			start_ref: { type: 'string', description: 'LINE:HASH of first line to replace' },
			end_ref: { type: 'string', description: 'LINE:HASH of last line to replace' },
			after_ref: { type: 'string', description: "LINE:HASH to insert after (or '0:000' for start)" },
			new_content: { type: 'string', description: 'Replacement text (raw, no hashline prefixes)' },
		}, required: ['path', 'operation', 'new_content'] },
		cache_control: { type: 'ephemeral' } },
	{ name: 'grep', description: 'Search file contents using ripgrep. Returns matching lines with file paths and line numbers.',
		input_schema: { type: 'object', properties: {
			pattern: { type: 'string', description: 'Search pattern (regex)' },
			path: { type: 'string', description: 'Directory or file to search (default: cwd)' },
			include: { type: 'string', description: "Glob pattern to filter files, e.g. '*.ts'" },
		}, required: ['pattern'] } },
	{ name: 'glob', description: 'Find files by glob pattern. Returns matching file paths sorted by modification time.',
		input_schema: { type: 'object', properties: {
			pattern: { type: 'string', description: "Glob pattern, e.g. '*.ts', 'src/**/*.tsx'" },
			path: { type: 'string', description: 'Directory to search in (default: cwd)' },
		}, required: ['pattern'] } },
	{ name: 'ls', description: 'List directory contents as a tree. Ignores node_modules, .git, dist, etc.',
		input_schema: { type: 'object', properties: {
			path: { type: 'string', description: 'Directory to list (default: cwd)' },
			depth: { type: 'integer', description: 'Max depth (default: 3)' },
		} } },
	{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 },
]

// ── Tool execution ──

export interface ToolCall { id: string; name: string; input: unknown }
type OnChunk = (text: string) => Promise<void>

export function argsPreview(call: ToolCall): string {
	const inp = call.input as any
	switch (call.name) {
		case 'bash': return String(inp?.command ?? '')
		case 'read': return String(inp?.path ?? '')
		case 'write': return String(inp?.path ?? '')
		case 'edit': return String(inp?.path ?? '')
		case 'grep': return String(inp?.pattern ?? '')
		case 'glob': return String(inp?.pattern ?? '')
		case 'ls': return String(inp?.path ?? '.')
		default: return call.name
	}
}

export async function executeTool(call: ToolCall, onChunk?: OnChunk): Promise<string> {
	const inp = call.input as any
	switch (call.name) {
		case 'bash': {
			const cmd = String(inp?.command ?? '')
			if (!cmd) return '(empty command)'
			const proc = Bun.spawn(['bash', '-lc', cmd], {
				cwd: CWD, stdout: 'pipe', stderr: 'pipe',
				env: { ...process.env, TERM: 'dumb' },
			})
			let out = ''
			const reader = proc.stdout.getReader()
			const decoder = new TextDecoder()
			while (true) {
				const { done, value } = await reader.read()
				if (done) break
				const chunk = decoder.decode(value, { stream: true })
				out += chunk
				if (onChunk) await onChunk(chunk)
			}
			const stderr = await new Response(proc.stderr).text()
			const code = await proc.exited
			if (stderr) out += (out ? '\n' : '') + stderr
			if (code !== 0) out += `\n[exit ${code}]`
			return truncate(out) || '(no output)'
		}
		case 'read': {
			const path = resolvePath(inp?.path)
			try {
				const s = statSync(path)
				if (s.isDirectory()) return `error: ${path} is a directory, use ls`
			} catch (e: any) { return `error: ${e.message}` }
			const content = readFileSync(path, 'utf-8')
			return truncate(formatHashlines(content, inp?.start, inp?.end))
		}
		case 'write': {
			const path = resolvePath(inp?.path)
			if (!inp?.path) return 'error: write requires path'
			const content = String(inp?.content ?? '')
			return withLock(path, async () => {
				await Bun.write(path, content)
				return 'ok'
			})
		}
		case 'edit': {
			const path = resolvePath(inp?.path)
			if (!inp?.path) return 'error: edit requires path'
			if (inp.operation !== 'replace' && inp.operation !== 'insert')
				return `error: unknown operation "${inp.operation}"`
			return withLock(path, async () => {
				const content = readFileSync(path, 'utf-8')
				let result: string
				if (inp.operation === 'replace') {
					if (!inp.start_ref || !inp.end_ref) return 'error: replace requires start_ref and end_ref'
					result = applyEdit(content, inp.start_ref, inp.end_ref, String(inp.new_content ?? ''))
				} else {
					if (!inp.after_ref) return 'error: insert requires after_ref'
					result = applyInsert(content, inp.after_ref, String(inp.new_content ?? ''))
				}
				if (result.startsWith('error:')) return result
				// result is context diff — extract new content from the edit and write
				const lines = content.split('\n')
				const newContent = String(inp.new_content ?? '').replace(/\n$/, '')
				const newLines = newContent === '' ? [] : newContent.split('\n')
				if (inp.operation === 'replace') {
					const start = parseRef(inp.start_ref)!, end = parseRef(inp.end_ref)!
					const resultLines = [...lines.slice(0, start.line - 1), ...newLines, ...lines.slice(end.line)]
					await Bun.write(path, resultLines.join('\n'))
				} else {
					const insertAt = inp.after_ref === '0:000' ? 0 : parseRef(inp.after_ref)!.line
					const resultLines = [...lines.slice(0, insertAt), ...newLines, ...lines.slice(insertAt)]
					await Bun.write(path, resultLines.join('\n'))
				}
				return result
			})
		}
		case 'grep': {
			const pattern = String(inp?.pattern ?? '')
			const searchPath = resolvePath(inp?.path)
			const args = ['rg', '-nH', '--no-heading', '--color=never', '--hidden', '--max-count=100', '--sort=modified']
			if (inp?.include) args.push('--glob', inp.include)
			args.push('--', pattern, searchPath)
			const result = await $`${args}`.quiet().nothrow()
			const raw = result.stdout.toString().trim()
			if (!raw) return 'No matches found.'
			return truncate(raw)
		}
		case 'glob': {
			const searchPath = resolvePath(inp?.path)
			const args = ['rg', '--files', '--hidden', '--sort=modified', '--glob', String(inp?.pattern ?? ''), searchPath]
			const result = await $`${args}`.quiet().nothrow()
			const raw = result.stdout.toString().trim()
			if (!raw) return 'No files found.'
			return truncate(raw)
		}
		case 'ls': {
			const dir = resolvePath(inp?.path)
			const maxDepth = inp?.depth ?? 3
			const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.cache', 'coverage', 'target'])
			const lines: string[] = []
			function walk(d: string, prefix: string, depth: number) {
				if (depth > maxDepth || lines.length > 500) return
				let entries: string[]
				try { entries = readdirSync(d).sort() } catch { return }
				for (const e of entries) {
					if (IGNORE.has(e)) continue
					if (lines.length > 500) { lines.push(`${prefix}... (truncated)`); return }
					try {
						const full = `${d}/${e}`
						if (statSync(full).isDirectory()) {
							lines.push(`${prefix}${e}/`)
							walk(full, prefix + '  ', depth + 1)
						} else lines.push(`${prefix}${e}`)
					} catch {}
				}
			}
			walk(dir, '', 0)
			return lines.join('\n') || '(empty directory)'
		}
		default:
			return `Unknown tool: ${call.name}`
	}
}
