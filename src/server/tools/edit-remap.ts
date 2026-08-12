import { editTracker } from './edit-tracker.ts'
import { hashline, type HashlineRef } from './hashline.ts'

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

export type TrackerUpdate =
	| { kind: 'skip' }
	| { kind: 'clear' }
	| { kind: 'replace'; start: number; end: number; newLineCount: number }
	| { kind: 'insert'; afterLine: number; newLineCount: number }

export interface PreparedEdit {
	resultLines: string[]
	diff: string
	changedStartLine: number
	changedLineCount: number
	trackerUpdate: TrackerUpdate
	remapNotice: string | null
}

export interface EditRequest {
	lines: string[]
	sessionId: string
	path: string
	operation: 'replace' | 'insert'
	startRef?: string
	endRef?: string
	afterRef?: string
	newContent: string
}

function formatRetryContext(lines: string[], startLine: number, endLine: number): string {
	if (lines.length === 0) return '[file is currently empty]'
	const from = Math.max(0, Math.min(startLine, endLine) - 1)
	const to = Math.max(from + 1, Math.min(lines.length, Math.max(startLine, endLine)))
	return hashline.formatContext(lines, from, to, CONTEXT_LINES)
}

function staleRefError(lines: string[], err: string, startLine: number, endLine = startLine): string {
	const context = formatRetryContext(lines, startLine, endLine)
	return `error: ${err}

Current file context around the requested edit:
${context}

Use these updated LINE:HASH refs to retry without a separate read.`
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

function applyReplace(lines: string[], resolved: ResolvedReplace, newContent: string): PreparedEdit {
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

function applyInsert(lines: string[], resolved: ResolvedInsert, newContent: string): PreparedEdit {
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

function prepareEdit(input: EditRequest): string | PreparedEdit {
	if (input.operation === 'replace') {
		if (!input.startRef || !input.endRef) return 'error: replace requires start_ref and end_ref'
		const resolved = resolveReplace(input.lines, input.sessionId, input.path, input.startRef, input.endRef, normalizeReplaceLines(input.newContent).length)
		return typeof resolved === 'string' ? resolved : applyReplace(input.lines, resolved, input.newContent)
	}

	if (!input.afterRef) return 'error: insert requires after_ref'
	const resolved = resolveInsert(input.lines, input.sessionId, input.path, input.afterRef, normalizeInsertLines(input.newContent).length)
	return typeof resolved === 'string' ? resolved : applyInsert(input.lines, resolved, input.newContent)
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

function buildResult(edit: PreparedEdit): string {
	return [
		edit.remapNotice,
		edit.diff,
		`Changed lines after edit:\n${formatChangedLines(edit.resultLines, edit.changedStartLine, edit.changedLineCount)}`,
	]
		.filter(Boolean)
		.join('\n\n')
}

export const editRemap = {
	normalizeReplaceLines,
	normalizeInsertLines,
	prepareEdit,
	applyTrackerUpdate,
	buildResult,
}
