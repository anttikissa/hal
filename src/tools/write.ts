// Write + Edit tools — file creation and surgical editing.
//
// Write: create or overwrite a file with full content.
// Edit: replace or insert using hashline refs from the read tool.
//   Hashes are verified before applying. When line numbers merely shifted after
//   earlier edits in the same session, we can remap them in memory.

import { readFileSync } from 'fs'
import { dirname, extname, resolve } from 'path'
import { ensureDir } from '../state.ts'
import { helpers } from '../utils/helpers.ts'
import { toolRegistry, type ToolContext } from './tool.ts'
import { read } from './read.ts'
import { hashline, type HashlineRef } from './hashline.ts'
import { editTracker } from './edit-tracker.ts'

// ── Shared helpers ──

const MAX_OUTPUT_BYTES = 1_000_000
const TRUNCATED_SUFFIX = '\n[… truncated]'
const REPO_ROOT = resolve(import.meta.dir, '../..')
const TSGO_FILE_SCRIPT = resolve(REPO_ROOT, 'scripts/tsgo-file.ts')
const textDecoder = new TextDecoder()

function ensureParent(path: string): void {
	ensureDir(dirname(path))
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
	return helpers.truncateUtf8(text, limit, TRUNCATED_SUFFIX)
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

interface ResolvedReplace {
	currentStart: HashlineRef
	currentEnd: HashlineRef
	trackerUpdate: TrackerUpdate
	remapNotice: string | null
}

interface ResolvedInsert {
	currentAfter: HashlineRef | '0:000'
	trackerUpdate: TrackerUpdate
	remapNotice: string | null
}

type TrackerUpdate =
	| { kind: 'skip' }
	| { kind: 'clear' }
	| { kind: 'replace'; start: number; end: number; newLineCount: number }
	| { kind: 'insert'; afterLine: number; newLineCount: number }

interface AppliedEdit {
	resultLines: string[]
	diff: string
	changedStartLine: number
	changedLineCount: number
	trackerUpdate: TrackerUpdate
	remapNotice: string | null
}

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

function normalizeReplaceLines(newContent: string): string[] {
	const normalized = newContent.replace(/\n$/, '')
	return normalized === '' ? [] : normalized.split('\n')
}

function normalizeInsertLines(newContent: string): string[] {
	const normalized = newContent.replace(/\n$/, '')
	return normalized.split('\n')
}

function formatChangedLines(lines: string[], startLine: number, lineCount: number): string {
	if (lineCount === 0) return '[no lines remain at the edited range]'
	return hashline.formatContext(lines, startLine - 1, startLine - 1 + lineCount, 0)
}

function formatRangeRef(start: HashlineRef, end: HashlineRef): string {
	if (start.line === end.line && start.hash === end.hash) return `${start.line}:${start.hash}`
	return `${start.line}:${start.hash}-${end.line}:${end.hash}`
}

function formatAfterRef(ref: HashlineRef | '0:000'): string {
	return ref === '0:000' ? ref : `${ref.line}:${ref.hash}`
}

function planReplaceTrackerUpdate(sessionId: string, path: string, currentStartLine: number, currentEndLine: number, newLineCount: number): TrackerUpdate {
	if (!editTracker.has(sessionId, path)) return { kind: 'skip' }
	const baseRange = editTracker.mapCurrentRangeToBase(sessionId, path, currentStartLine, currentEndLine)
	if (!baseRange) return { kind: 'clear' }
	return { kind: 'replace', start: baseRange.startLine, end: baseRange.endLine, newLineCount }
}

function planInsertTrackerUpdate(sessionId: string, path: string, currentAfterLine: number, newLineCount: number): TrackerUpdate {
	if (!editTracker.has(sessionId, path)) return { kind: 'skip' }
	const baseAfterLine = editTracker.mapCurrentLineToBase(sessionId, path, currentAfterLine)
	if (baseAfterLine === null) return { kind: 'clear' }
	return { kind: 'insert', afterLine: baseAfterLine, newLineCount }
}

function validateReplaceRange(lines: string[], start: HashlineRef, end: HashlineRef): string | null {
	const startErr = hashline.validateRef(start, lines)
	const endErr = hashline.validateRef(end, lines)
	if (startErr) return startErr
	if (endErr) return endErr
	if (start.line > end.line) return `error: start line ${start.line} is after end line ${end.line}`
	return null
}

function resolveReplace(lines: string[], sessionId: string, path: string, startRef: string, endRef: string, newLineCount: number): string | ResolvedReplace {
	const start = hashline.parseRef(startRef)
	const end = hashline.parseRef(endRef)
	if (!start) return `error: invalid start_ref: ${startRef}`
	if (!end) return `error: invalid end_ref: ${endRef}`

	const rawError = validateReplaceRange(lines, start, end)
	if (!rawError) {
		return {
			currentStart: start,
			currentEnd: end,
			trackerUpdate: planReplaceTrackerUpdate(sessionId, path, start.line, end.line, newLineCount),
			remapNotice: null,
		}
	}
	if (rawError.startsWith('error: start line')) return rawError

	const mapped = editTracker.mapBaseRangeToCurrent(sessionId, path, start.line, end.line)
	if (!mapped) return staleRefError(lines, rawError, start.line, end.line)

	const mappedStart = { line: mapped.startLine, hash: start.hash }
	const mappedEnd = { line: mapped.endLine, hash: end.hash }
	const mappedError = validateReplaceRange(lines, mappedStart, mappedEnd)
	if (mappedError) return staleRefError(lines, rawError, start.line, end.line)

	return {
		currentStart: mappedStart,
		currentEnd: mappedEnd,
		trackerUpdate: { kind: 'replace', start: start.line, end: end.line, newLineCount },
		remapNotice: `Line numbers changed; edit accepted as ${formatRangeRef(mappedStart, mappedEnd)}.`,
	}
}

function resolveInsert(lines: string[], sessionId: string, path: string, afterRef: string, newLineCount: number): string | ResolvedInsert {
	if (afterRef === '0:000') {
		return {
			currentAfter: '0:000',
			trackerUpdate: editTracker.has(sessionId, path) ? { kind: 'insert', afterLine: 0, newLineCount } : { kind: 'skip' },
			remapNotice: null,
		}
	}

	const after = hashline.parseRef(afterRef)
	if (!after) return `error: invalid after_ref: ${afterRef}`

	const rawError = hashline.validateRef(after, lines)
	if (!rawError) {
		return {
			currentAfter: after,
			trackerUpdate: planInsertTrackerUpdate(sessionId, path, after.line, newLineCount),
			remapNotice: null,
		}
	}

	const mappedLine = editTracker.mapBaseLineToCurrent(sessionId, path, after.line)
	if (mappedLine === null) return staleRefError(lines, rawError, after.line)

	const mappedAfter = { line: mappedLine, hash: after.hash }
	const mappedError = hashline.validateRef(mappedAfter, lines)
	if (mappedError) return staleRefError(lines, rawError, after.line)

	return {
		currentAfter: mappedAfter,
		trackerUpdate: { kind: 'insert', afterLine: after.line, newLineCount },
		remapNotice: `Line numbers changed; edit accepted after ${formatAfterRef(mappedAfter)}.`,
	}
}

function applyReplace(lines: string[], resolved: ResolvedReplace, newContent: string): AppliedEdit {
	const before = hashline.formatContext(lines, resolved.currentStart.line - 1, resolved.currentEnd.line, CONTEXT_LINES)
	const newLines = normalizeReplaceLines(newContent)
	const resultLines = [
		...lines.slice(0, resolved.currentStart.line - 1),
		...newLines,
		...lines.slice(resolved.currentEnd.line),
	]
	const after = hashline.formatContext(
		resultLines,
		resolved.currentStart.line - 1,
		resolved.currentStart.line - 1 + newLines.length,
		CONTEXT_LINES,
	)
	return {
		resultLines,
		diff: `--- before\n${before}\n\n+++ after\n${after}`,
		changedStartLine: resolved.currentStart.line,
		changedLineCount: newLines.length,
		trackerUpdate: resolved.trackerUpdate,
		remapNotice: resolved.remapNotice,
	}
}

function applyInsert(lines: string[], resolved: ResolvedInsert, newContent: string): AppliedEdit {
	const newLines = normalizeInsertLines(newContent)
	const insertAt = resolved.currentAfter === '0:000' ? 0 : resolved.currentAfter.line
	const before = hashline.formatContext(lines, insertAt, insertAt, CONTEXT_LINES)
	const resultLines = [...lines.slice(0, insertAt), ...newLines, ...lines.slice(insertAt)]
	const after = hashline.formatContext(resultLines, insertAt, insertAt + newLines.length, CONTEXT_LINES)
	return {
		resultLines,
		diff: `--- before\n${before}\n\n+++ after\n${after}`,
		changedStartLine: insertAt + 1,
		changedLineCount: newLines.length,
		trackerUpdate: resolved.trackerUpdate,
		remapNotice: resolved.remapNotice,
	}
}

function applyTrackerUpdate(sessionId: string, path: string, update: TrackerUpdate): void {
	if (update.kind === 'skip') return
	if (update.kind === 'clear') {
		editTracker.clear(sessionId, path)
		return
	}
	if (update.kind === 'replace') {
		editTracker.applyReplace(sessionId, path, update.start, update.end, update.newLineCount)
		return
	}
	editTracker.applyInsert(sessionId, path, update.afterLine, update.newLineCount)
}

function buildEditResult(path: string, applied: AppliedEdit, typecheckError: string | null): string {
	const parts = [
		applied.remapNotice,
		applied.diff,
		`Changed lines after edit:\n${formatChangedLines(applied.resultLines, applied.changedStartLine, applied.changedLineCount)}`,
	]
	if (typecheckError) parts.push(`TypeScript check failed for ${path}:\n${typecheckError}`)
	return truncateUtf8(parts.filter(Boolean).join('\n\n'), MAX_OUTPUT_BYTES)
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

		let applied: string | AppliedEdit
		if (operation === 'replace') {
			if (!input?.start_ref || !input?.end_ref) return 'error: replace requires start_ref and end_ref'
			const resolved = resolveReplace(lines, ctx.sessionId, path, input.start_ref, input.end_ref, normalizeReplaceLines(newContent).length)
			applied = typeof resolved === 'string' ? resolved : applyReplace(lines, resolved, newContent)
		} else {
			if (!input?.after_ref) return 'error: insert requires after_ref'
			const resolved = resolveInsert(lines, ctx.sessionId, path, input.after_ref, normalizeInsertLines(newContent).length)
			applied = typeof resolved === 'string' ? resolved : applyInsert(lines, resolved, newContent)
		}

		if (typeof applied === 'string') return applied

		ensureParent(path)
		await Bun.write(path, applied.resultLines.join('\n') + '\n')
		applyTrackerUpdate(ctx.sessionId, path, applied.trackerUpdate)

		const typecheckError = runTypecheckForEdit(path)
		return buildEditResult(path, applied, typecheckError)
	})
}

const editTool = {
	name: 'edit',
	description: `Edit a file using hashline refs from read. Hashes are verified; line numbers may be remapped after prior edits in the same session.
- replace: replace start_ref..end_ref (inclusive) with new_content. Same ref for single line. Empty new_content to delete.
- insert: insert new_content after after_ref. Use "0:000" for beginning of file.
- if the edited file ends in .ts or .tsx, run tsgo-file on it and return type errors if broken.
new_content is raw file content — no hashline prefixes. A trailing newline in new_content is stripped.`,
	parameters: {
		path: { type: 'string', description: 'File path (absolute or relative to cwd)' },
		operation: { type: 'string', description: '"replace" or "insert"' },
		start_ref: { type: 'string', description: 'LINE:HASH of first line to replace' },
		end_ref: { type: 'string', description: 'LINE:HASH of last line to replace' },
		after_ref: { type: 'string', description: 'LINE:HASH to insert after (or \"0:000\" for start)' },
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
