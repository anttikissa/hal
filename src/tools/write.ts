// Write + Edit tools — file creation and surgical editing.
//
// Write: create or overwrite a file with full content.
// Edit: replace or insert using hashline refs from the read tool.
//   Hashes are verified before applying — if the file changed since
//   the last read, the hash won't match and the edit is rejected.

import { readFileSync, existsSync, mkdirSync } from 'fs'
import { dirname, extname, resolve } from 'path'
import { toolRegistry, type ToolContext } from './tool.ts'
import { read } from './read.ts'
import { hashline } from './hashline.ts'

// ── Shared helpers ──

const MAX_OUTPUT_BYTES = 1_000_000
const TRUNCATED_SUFFIX = '\n[… truncated]'
const REPO_ROOT = resolve(import.meta.dir, '../..')
const TSGO_FILE_SCRIPT = resolve(REPO_ROOT, 'scripts/tsgo-file.ts')
const textDecoder = new TextDecoder()

function ensureParent(path: string): void {
	const dir = dirname(path)
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

// Simple per-path lock to prevent concurrent writes to the same file.
const locks = new Map<string, Promise<void>>()

function withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
	const prev = locks.get(path) ?? Promise.resolve()
	const result = prev.then(fn, fn)
	const done = result.then(
		() => {},
		() => {},
	)
	locks.set(path, done)
	done.then(() => {
		if (locks.get(path) === done) locks.delete(path)
	})
	return result
}

// Keep tool outputs under the 1 MB cap even when tsgo prints a long error list.
function truncateUtf8(text: string, limit: number): string {
	if (Buffer.byteLength(text, 'utf8') <= limit) return text

	const suffixBytes = Buffer.byteLength(TRUNCATED_SUFFIX, 'utf8')
	const budget = limit - suffixBytes
	if (budget <= 0) return TRUNCATED_SUFFIX.slice(0, limit)

	let lo = 0
	let hi = text.length
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2)
		if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= budget) {
			lo = mid
		} else {
			hi = mid - 1
		}
	}
	return text.slice(0, lo) + TRUNCATED_SUFFIX
}

function shouldTypecheckEditedPath(path: string): boolean {
	const ext = extname(path)
	return ext === '.ts' || ext === '.tsx'
}

function decodeOutput(bytes: Uint8Array<ArrayBufferLike> | null | undefined): string {
	if (!bytes) return ''
	return textDecoder.decode(bytes)
}

function runTypecheckForEdit(path: string): string | null {
	if (!shouldTypecheckEditedPath(path)) return null

	const proc = Bun.spawnSync(['bun', TSGO_FILE_SCRIPT, path], {
		cwd: REPO_ROOT,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
	})
	if ((proc.exitCode ?? 1) === 0) return null

	const stdout = decodeOutput(proc.stdout).trim()
	const stderr = decodeOutput(proc.stderr).trim()
	const details = [stdout, stderr].filter(Boolean).join('\n')
	const fallback = `bun scripts/tsgo-file.ts exited ${proc.exitCode ?? 1}`
	return truncateUtf8(details || fallback, MAX_OUTPUT_BYTES)
}

// ── Write tool ──

async function executeWrite(input: any, ctx: ToolContext): Promise<string> {
	const path = read.resolvePath(input?.path, ctx.cwd)
	const content = String(input?.content ?? '')

	return withLock(path, async () => {
		ensureParent(path)
		await Bun.write(path, content)

		const lines = content.split('\n')
		const preview = lines.slice(0, 5).join('\n')
		if (lines.length <= 5) return `Wrote ${path} (${lines.length} lines)\n${preview}`
		return `Wrote ${path} (${lines.length} lines)\n${preview}\n[+ ${lines.length - 5} more lines]`
	})
}

const writeTool = {
	name: 'write',
	description: 'Create or overwrite a file with the given content.',
	parameters: {
		path: { type: 'string', description: 'File path (absolute or relative to cwd)' },
		content: { type: 'string', description: 'Full file content' },
	},
	required: ['path', 'content'],
	execute: executeWrite,
}

// ── Edit tool ──

const CONTEXT_LINES = 3

function formatRetryContext(lines: string[], startLine: number, endLine: number): string {
	if (lines.length === 0) return '[file is currently empty]'
	const from = Math.max(0, Math.min(startLine, endLine) - 1)
	const to = Math.max(from + 1, Math.min(lines.length, Math.max(startLine, endLine)))
	return hashline.formatContext(lines, from, to, CONTEXT_LINES)
}

function staleRefError(lines: string[], err: string, startLine: number, endLine = startLine): string {
	const context = formatRetryContext(lines, startLine, endLine)
	return truncateUtf8(
		`error: ${err}

Current file context around the requested edit:
${context}

Use these updated LINE:HASH refs to retry without a separate read.`,
		MAX_OUTPUT_BYTES,
	)
}

function applyReplace(lines: string[], startRef: string, endRef: string, newContent: string): string | { resultLines: string[]; diff: string } {
	const start = hashline.parseRef(startRef)
	const end = hashline.parseRef(endRef)
	if (!start) return `error: invalid start_ref: ${startRef}`
	if (!end) return `error: invalid end_ref: ${endRef}`

	const startErr = hashline.validateRef(start, lines)
	const endErr = hashline.validateRef(end, lines)
	if (startErr) return staleRefError(lines, startErr, start.line, end.line)
	if (endErr) return staleRefError(lines, endErr, start.line, end.line)
	if (start.line > end.line) return `error: start line ${start.line} is after end line ${end.line}`

	const before = hashline.formatContext(lines, start.line - 1, end.line, CONTEXT_LINES)
	// Strip trailing newline from new_content (each line already gets one on join)
	const normalized = newContent.replace(/\n$/, '')
	const newLines = normalized === '' ? [] : normalized.split('\n')
	const resultLines = [...lines.slice(0, start.line - 1), ...newLines, ...lines.slice(end.line)]
	const after = hashline.formatContext(resultLines, start.line - 1, start.line - 1 + newLines.length, CONTEXT_LINES)
	return { resultLines, diff: `--- before\n${before}\n\n+++ after\n${after}` }
}

function applyInsert(lines: string[], afterRef: string, newContent: string): string | { resultLines: string[]; diff: string } {
	const normalized = newContent.replace(/\n$/, '')
	const newLines = normalized.split('\n')

	let insertAt: number
	if (afterRef === '0:000') {
		insertAt = 0
	} else {
		const ref = hashline.parseRef(afterRef)
		if (!ref) return `error: invalid after_ref: ${afterRef}`
		const err = hashline.validateRef(ref, lines)
		if (err) return staleRefError(lines, err, ref.line)
		insertAt = ref.line
	}

	const before = hashline.formatContext(lines, insertAt, insertAt, CONTEXT_LINES)
	const resultLines = [...lines.slice(0, insertAt), ...newLines, ...lines.slice(insertAt)]
	const after = hashline.formatContext(resultLines, insertAt, insertAt + newLines.length, CONTEXT_LINES)
	return { resultLines, diff: `--- before\n${before}\n\n+++ after\n${after}` }
}

async function executeEdit(input: any, ctx: ToolContext): Promise<string> {
	const path = read.resolvePath(input?.path, ctx.cwd)
	const operation = input?.operation
	const newContent = String(input?.new_content ?? '')

	if (operation !== 'replace' && operation !== 'insert') {
		return `error: unknown operation "${operation}" (use "replace" or "insert")`
	}

	return withLock(path, async () => {
		let content: string
		try {
			content = readFileSync(path, 'utf-8')
		} catch {
			return `error: file not found: ${path}`
		}

		const lines = hashline.toLines(content)

		let applied: string | { resultLines: string[]; diff: string }
		if (operation === 'replace') {
			if (!input?.start_ref || !input?.end_ref) return 'error: replace requires start_ref and end_ref'
			applied = applyReplace(lines, input.start_ref, input.end_ref, newContent)
		} else {
			if (!input?.after_ref) return 'error: insert requires after_ref'
			applied = applyInsert(lines, input.after_ref, newContent)
		}

		if (typeof applied === 'string') return applied

		ensureParent(path)
		await Bun.write(path, applied.resultLines.join('\n') + '\n')

		const typecheckError = runTypecheckForEdit(path)
		if (!typecheckError) return applied.diff

		return truncateUtf8(
			`${applied.diff}\n\nTypeScript check failed for ${path}:\n${typecheckError}`,
			MAX_OUTPUT_BYTES,
		)
	})
}

const editTool = {
	name: 'edit',
	description: `Edit a file using hashline refs from read. Hashes are verified; mismatch = re-read needed.
- replace: replace start_ref..end_ref (inclusive) with new_content. Same ref for single line. Empty new_content to delete.
- insert: insert new_content after after_ref. Use "0:000" for beginning of file.
- if the edited file ends in .ts or .tsx, run tsgo-file on it and return type errors if broken.
new_content is raw file content — no hashline prefixes. A trailing newline in new_content is stripped.`,
	parameters: {
		path: { type: 'string', description: 'File path (absolute or relative to cwd)' },
		operation: { type: 'string', description: '"replace" or "insert"' },
		start_ref: { type: 'string', description: 'LINE:HASH of first line to replace' },
		end_ref: { type: 'string', description: 'LINE:HASH of last line to replace' },
		after_ref: { type: 'string', description: "LINE:HASH to insert after (or '0:000' for start)" },
		new_content: { type: 'string', description: 'Replacement text (raw, no hashline prefixes)' },
	},
	required: ['path', 'operation', 'new_content'],
	execute: executeEdit,
}

function init(): void {
	toolRegistry.registerTool(writeTool)
	toolRegistry.registerTool(editTool)
}

export const write = { executeWrite, executeEdit, init }
