// Prompt editing: state, key handling, wrapping, selection, undo, history.
// Merged from previous/ prompt.ts + input.ts.

import { clipboard } from './clipboard.ts'
import type { KeyEvent } from './keys.ts'
import { expandTabs, glyphWidthAt, visLen, wordWrap } from '../utils/strings.ts'

const MAX_UNDO = 200
const SELECTION_ON = '\x1b[7m'
const SELECTION_OFF = '\x1b[27m'

const config = {
	maxPromptLines: 10,
}

const state = {
	// 0 means use config.maxPromptLines. Ctrl-= / Ctrl-- sets an explicit
	// live viewport height for composing unusually long prompts.
	promptLineLimit: 0,
	promptScrollTop: 0,
}


// ── Word wrap + cursor mapping ───────────────────────────────────────────────

interface WrappedLayout {
	lines: string[]
	starts: number[] // character offset where each wrapped line begins
	ends: number[]
}

function getLayout(input: string, width: number): WrappedLayout {
	const lines = wordWrap(input, width)
	const starts: number[] = []
	const ends: number[] = []
	let pos = 0
	for (const line of lines) {
		starts.push(pos)
		ends.push(pos + line.length)
		const nextChar = pos + line.length < input.length ? input[pos + line.length] : ''
		pos += line.length + (nextChar === ' ' || nextChar === '\n' ? 1 : 0)
	}
	return { lines, starts, ends }
}

function cursorToRowCol(input: string, absPos: number, width: number): { row: number; col: number } {
	const layout = getLayout(input, width)
	for (let i = 0; i < layout.lines.length; i++) {
		const nextStart = i < layout.lines.length - 1 ? layout.starts[i + 1]! : input.length + 1
		if (absPos < nextStart) return { row: i, col: visLen(input.slice(layout.starts[i]!, Math.min(absPos, layout.ends[i]!))) }
	}
	const last = layout.lines.length - 1
	return { row: last, col: visLen(layout.lines[last] ?? '') }
}


function rowColToCursor(input: string, row: number, col: number, width: number): number {
	const layout = getLayout(input, width)
	if (layout.lines.length === 0) return 0
	const r = Math.max(0, Math.min(row, layout.lines.length - 1))
	let vis = 0
	for (let i = layout.starts[r]!; i < layout.ends[r]!;) {
		const glyph = glyphWidthAt(input, i, vis)
		// A multi-column glyph has no cursor positions inside it, so choose its nearest edge.
		if (vis + glyph.width > col && col - vis < glyph.width / 2) return i
		if (vis + glyph.width > col) return i + glyph.length
		vis += glyph.width
		i += glyph.length
	}
	return layout.ends[r]!
}

function verticalMove(
	input: string,
	width: number,
	cur: number,
	goal: number | null,
	dir: -1 | 1,
): { cursor: number; goalCol: number; atBoundary: boolean } {
	const { lines } = getLayout(input, width)
	const { row, col } = cursorToRowCol(input, cur, width)
	const g = goal ?? col
	const target = row + dir
	if (target < 0 || target >= lines.length) return { cursor: cur, goalCol: g, atBoundary: true }
	return {
		cursor: rowColToCursor(input, target, g, width),
		goalCol: g,
		atBoundary: false,
	}
}

function atVerticalBoundary(dir: -1 | 1, contentWidth: number): boolean {
	return verticalMove(buf, contentWidth, cursor, goalCol, dir).atBoundary
}


function wordLeft(text: string, pos: number): number {
	let i = pos - 1
	while (i > 0 && /\s/.test(text[i]!)) i--
	while (i > 0 && !/\s/.test(text[i - 1]!)) i--
	return Math.max(0, i)
}

function wordRight(text: string, pos: number): number {
	let i = pos
	while (i < text.length && /\s/.test(text[i]!)) i++
	while (i < text.length && !/\s/.test(text[i]!)) i++
	return i
}

// Option+Left/Right treats words and punctuation runs as tokens. Moving right
// lands at token ends; moving left lands at token starts. Spaces are skipped.
function isWordTokenChar(ch: string): boolean {
	return /[\p{L}\p{N}\p{M}_]/u.test(ch)
}

function isSpaceChar(ch: string): boolean {
	return /\s/.test(ch)
}

function isPunctuationTokenChar(ch: string): boolean {
	return !isWordTokenChar(ch) && !isSpaceChar(ch)
}

function optionWordLeft(text: string, pos: number): number {
	let i = pos
	while (i > 0 && isSpaceChar(text[i - 1]!)) i--
	if (i === 0) return 0

	if (isWordTokenChar(text[i - 1]!)) {
		while (i > 0 && isWordTokenChar(text[i - 1]!)) i--
		return i
	}

	while (i > 0 && isPunctuationTokenChar(text[i - 1]!)) i--
	return i
}

function optionWordRight(text: string, pos: number): number {
	let i = pos
	while (i < text.length && isSpaceChar(text[i]!)) i++
	if (i === text.length) return i

	if (isWordTokenChar(text[i]!)) {
		while (i < text.length && isWordTokenChar(text[i]!)) i++
		return i
	}

	while (i < text.length && isPunctuationTokenChar(text[i]!)) i++
	return i
}

// ── State ────────────────────────────────────────────────────────────────────

let buf = ''
let cursor = 0
let goalCol: number | null = null
let selAnchor: number | null = null

// Readline-style kill/yank buffer. This is intentionally local to the
// client process: Ctrl-K/Ctrl-U fill it, Ctrl-Y inserts it, and it never
// touches the OS clipboard, session files, or server runtime.
let killBuffer = ''

// Undo / redo
interface Snapshot {
	text: string
	cursor: number
	selAnchor: number | null
}
let undoStack: Snapshot[] = []
let redoStack: Snapshot[] = []
let undoGrouping = false

// History (submitted messages)
let history: string[] = []
let historyIndex = -1
let historyDraft = ''

export interface PromptEditorState {
	text: string
	cursor: number
	goalCol: number | null
	selAnchor: number | null
	undoStack: Snapshot[]
	redoStack: Snapshot[]
	undoGrouping: boolean
	history: string[]
	historyIndex: number
	historyDraft: string
	pasteRefs: Array<{ display: string; text: string }>
	promptLineLimit: number
	promptScrollTop?: number
}

// Called when async paste resolves (image placeholder -> path)
let renderCallback: (() => void) | null = null

// Multiline pastes are displayed as the old temp-file marker so humans can
// tell pastes apart and open them in an external editor. submitText() expands
// those markers back to the original pasted text for the model.
const pasteRefs: Array<{ display: string; text: string }> = []

// ── Helpers ──────────────────────────────────────────────────────────────────

function clamp(pos: number): number {
	return Math.max(0, Math.min(pos, buf.length))
}

function defaultPromptLineLimit(): number {
	return Math.max(1, Math.floor(config.maxPromptLines))
}

function promptLineLimit(): number {
	if (state.promptLineLimit > 0) return Math.max(1, Math.floor(state.promptLineLimit))
	return defaultPromptLineLimit()
}

function autoPromptLineCount(contentWidth: number): number {
	return Math.min(promptRows(contentWidth), defaultPromptLineLimit())
}

function resizePromptLineLimit(dir: -1 | 1, contentWidth: number): void {
	const autoLines = autoPromptLineCount(contentWidth)
	const current = state.promptLineLimit > 0 ? promptLineLimit() : autoLines
	if (dir > 0) {
		state.promptLineLimit = current + 1
		return
	}
	state.promptLineLimit = Math.max(autoLines, current - 1)
	if (state.promptLineLimit === autoLines) state.promptLineLimit = 0
}

function promptRows(contentWidth: number): number {
	const layout = getLayout(buf, contentWidth)
	const { row: curRow } = cursorToRowCol(buf, cursor, contentWidth)
	return Math.max(layout.lines.length, curRow + 1)
}

function resizeHint(contentWidth: number): string | null {
	if (!buf.trim()) return null
	const maxRows = promptLineLimit()
	if (promptRows(contentWidth) < Math.max(1, maxRows - 2)) return null
	return 'resize editor'
}

function clearSelectionAndGoal(): void {
	selAnchor = null
	goalCol = null
}

function cloneSnapshot(snap: Snapshot): Snapshot {
	return { text: snap.text, cursor: snap.cursor, selAnchor: snap.selAnchor }
}

function selRange(): { start: number; end: number } | null {
	if (selAnchor === null) return null
	const lo = Math.min(selAnchor, cursor)
	const hi = Math.max(selAnchor, cursor)
	return lo === hi ? null : { start: lo, end: hi }
}

function pushUndo(): void {
	const prev = undoStack[undoStack.length - 1]
	if (prev && prev.text === buf && prev.cursor === cursor) return
	undoStack.push({ text: buf, cursor, selAnchor })
	if (undoStack.length > MAX_UNDO) undoStack.splice(0, undoStack.length - MAX_UNDO)
	redoStack.length = 0
}

function applyInsertion(text: string): void {
	const sel = selRange()
	if (sel) {
		buf = buf.slice(0, sel.start) + text + buf.slice(sel.end)
		cursor = sel.start + text.length
	} else {
		buf = buf.slice(0, cursor) + text + buf.slice(cursor)
		cursor += text.length
	}
	clearSelectionAndGoal()
}

function restoreSnapshot(snap: Snapshot): void {
	buf = snap.text
	cursor = clamp(snap.cursor)
	selAnchor = snap.selAnchor
	goalCol = null
}

function stepHistory(from: Snapshot[], to: Snapshot[]): boolean {
	undoGrouping = false
	const snap = from.pop()
	if (!snap) return false
	to.push({ text: buf, cursor, selAnchor })
	restoreSnapshot(snap)
	return true
}

function loadHistoryText(text: string, dir: -1 | 1, contentWidth: number): void {
	buf = text
	// History browsing is bash-like: recalled entries put the cursor at the end
	// of the row selected by browse direction. Up enters an older entry on its
	// bottom visual row; down enters a newer entry/draft on its top visual row.
	const layout = getLayout(buf, contentWidth)
	const targetRow = dir === -1 ? Math.max(0, layout.lines.length - 1) : 0
	cursor = layout.ends[targetRow] ?? buf.length
	selAnchor = null
	goalCol = null
}

function browseHistory(dir: -1 | 1, contentWidth: number): boolean {
	if (history.length === 0) return false
	if (dir === -1) {
		if (historyIndex < 0) {
			historyDraft = buf
			historyIndex = history.length - 1
			// Just-sent edit mode preloads the latest prompt; skip reloading it.
			if (historyIndex > 0 && history[historyIndex] === buf) historyIndex--
		} else if (historyIndex > 0) {
			historyIndex--
		} else {
			moveEdge(-1, false)
			return true
		}
		loadHistoryText(history[historyIndex]!, dir, contentWidth)
		return true
	}
	if (historyIndex < 0) {
		moveEdge(1, false)
		return true
	}
	if (historyIndex < history.length - 1) {
		historyIndex++
		loadHistoryText(history[historyIndex]!, dir, contentWidth)
		return true
	}
	historyIndex = -1
	loadHistoryText(historyDraft, dir, contentWidth)
	historyDraft = ''
	return true
}

// ── Mutations ────────────────────────────────────────────────────────────────

function replaceSelection(text: string): void {
	pushUndo()
	applyInsertion(text)
}

function indentRows(deindent: boolean): void {
	const sel = selRange()
	const first = buf.lastIndexOf('\n', (sel?.start ?? cursor) - 1) + 1
	let end = sel?.end ?? cursor
	// A selection ending at the next row's first column does not select that row.
	if (sel && buf[end - 1] === '\n') end--
	let last = buf.indexOf('\n', end)
	if (last < 0) last = buf.length
	const before = buf.slice(first, last)
	let pattern = /^/gm
	let inserted = '\t'
	if (deindent) {
		pattern = /^(?: {1,3}\t| {1,4}|\t)/gm
		inserted = ''
	}
	const after = before.replace(pattern, inserted)
	if (after === before) return
	pushUndo()
	function remap(offset: number): number {
		if (offset < first) return offset
		if (offset >= last) return offset + after.length - before.length
		return first + before.slice(0, offset - first).replace(pattern, inserted).length
	}
	cursor = remap(cursor)
	if (selAnchor !== null) selAnchor = remap(selAnchor)
	if (!deindent && selAnchor !== null) {
		if (selAnchor < cursor) selAnchor = first
		else cursor = first
	}
	buf = buf.slice(0, first) + after + buf.slice(last)
	goalCol = null
}

function replaceSelectionWithPastedText(text: string): void {
	if (!clipboard.shouldSaveMultilinePaste(text)) {
		replaceSelection(text)
		return
	}
	const display = clipboard.saveMultilinePaste(text)
	pasteRefs.push({ display, text })
	replaceSelection(display)
}

// Single char insert — consecutive inserts coalesce into one undo group
function typeChar(ch: string): void {
	if (!undoGrouping) pushUndo()
	undoGrouping = true
	applyInsertion(ch)
}

function deleteRange(start: number, end: number): void {
	pushUndo()
	buf = buf.slice(0, start) + buf.slice(end)
	cursor = start
	clearSelectionAndGoal()
}

function deleteSel(): boolean {
	const sel = selRange()
	if (!sel) return false
	deleteRange(sel.start, sel.end)
	return true
}

function deleteBackward(byWord = false): void {
	if (!deleteSel() && cursor > 0) deleteRange(byWord ? wordLeft(buf, cursor) : cursor - 1, cursor)
}

function deleteForward(): void {
	if (!deleteSel() && cursor < buf.length) deleteRange(cursor, cursor + 1)
}

function killRange(start: number, end: number): void {
	if (start === end) return
	killBuffer = buf.slice(start, end)
	deleteRange(start, end)
}

function yankKillBuffer(): void {
	if (killBuffer) replaceSelection(killBuffer)
}

function move(pos: number, selecting: boolean): void {
	if (selecting) {
		if (selAnchor === null) selAnchor = cursor
	} else {
		selAnchor = null
	}
	cursor = clamp(pos)
	goalCol = null
}

function moveEdge(dir: -1 | 1, selecting: boolean): void {
	move(dir === -1 ? 0 : buf.length, selecting)
}

// Move to start (-1) or end (1) of the current line (readline ctrl-a/ctrl-e).
function moveLineEdge(dir: -1 | 1, selecting: boolean): void {
	if (dir === -1) {
		const lineStart = buf.lastIndexOf('\n', cursor - 1) + 1
		move(lineStart, selecting)
	} else {
		let lineEnd = buf.indexOf('\n', cursor)
		if (lineEnd === -1) lineEnd = buf.length
		move(lineEnd, selecting)
	}
}

function moveHorizontal(dir: -1 | 1, selecting: boolean, motion: 'char' | 'word' = 'char'): void {
	const pos = motion === 'word'
		? dir === -1 ? optionWordLeft(buf, cursor) : optionWordRight(buf, cursor)
		: cursor + dir
	if (motion === 'char' && !selecting) collapseOrMove(pos, dir === -1 ? 'start' : 'end')
	else move(pos, selecting)
}

// Collapse selection to one edge, or move if no selection
function collapseOrMove(pos: number, edge: 'start' | 'end'): void {
	const sel = selRange()
	if (sel) {
		cursor = edge === 'start' ? sel.start : sel.end
		clearSelectionAndGoal()
	} else {
		move(pos, false)
	}
}

function stepUndo(redo = false): boolean {
	return redo ? stepHistory(redoStack, undoStack) : stepHistory(undoStack, redoStack)
}

// ── Clipboard ────────────────────────────────────────────────────────────────

function writeToClipboard(text: string): void {
	if (!text) return
	try {
		const p = Bun.spawn(['pbcopy'], { stdin: 'pipe' })
		p.stdin.write(text)
		p.stdin.end()
	} catch {}
}

function resolvePlaceholder(placeholder: string, replacement: string): void {
	const idx = buf.lastIndexOf(placeholder)
	if (idx < 0) return
	buf = buf.slice(0, idx) + replacement + buf.slice(idx + placeholder.length)
	if (cursor > idx) cursor += replacement.length - placeholder.length
	cursor = clamp(cursor)
	renderCallback?.()
}

function doPaste(): void {
	const t = clipboard.cleanPaste(clipboard.pasteFromClipboard())
	if (t) replaceSelectionWithPastedText(t)
}

// ── Key handling ─────────────────────────────────────────────────────────────
// Returns true if handled, false to let keybindings (submit, etc.) handle it.

function moveVerticalKey(dir: -1 | 1, selecting: boolean, contentWidth: number): void {
	if (selecting && selAnchor === null) selAnchor = cursor
	const next = verticalMove(buf, contentWidth, cursor, goalCol, dir)
	if (!next.atBoundary) {
		if (!selecting) selAnchor = null
		cursor = next.cursor
		goalCol = next.goalCol
		return
	}
	if (!selecting && browseHistory(dir, contentWidth)) return
	if (selecting) {
		cursor = dir === -1 ? 0 : buf.length
		goalCol = null
		return
	}
	moveEdge(dir, false)
}

function handleCmdKey(k: KeyEvent): boolean {
	switch (k.key) {
		case 'c': {
			const sel = selRange()
			if (sel) writeToClipboard(buf.slice(sel.start, sel.end))
			return true
		}
		case 'x': {
			const sel = selRange()
			if (sel) {
				writeToClipboard(buf.slice(sel.start, sel.end))
				deleteRange(sel.start, sel.end)
			}
			return true
		}
		case 'v':
			doPaste()
			return true
		case 'a':
			selAnchor = 0
			cursor = buf.length
			return true
		case 'left':
			moveEdge(-1, k.shift)
			return true
		case 'right':
			moveEdge(1, k.shift)
			return true
		case 'u':
			stepUndo(k.shift)
			return true
		case 'z':
			stepUndo(k.shift)
			return true
		default:
			return false
	}
}

function handleKey(k: KeyEvent, contentWidth: number): boolean {
	// Any non-single-char key breaks the typing undo group
	if (!(k.char && k.char.length === 1 && !k.ctrl && !k.alt && !k.cmd)) undoGrouping = false
	if (k.cmd) return handleCmdKey(k)

	if (k.key === 'enter') {
		if (!k.shift && !k.alt) return false
		replaceSelection('\n')
		return true
	}

	switch (k.key) {
		case 'tab':
			if (k.shift || selRange()) {
				indentRows(k.shift)
				return true
			}
			replaceSelection('\t')
			return true
		case 'backspace':
			deleteBackward(k.alt)
			return true
		case 'delete':
			deleteForward()
			return true
		case 'd':
			if (k.ctrl) {
				if (buf.length === 0) return false
				deleteForward()
				return true
			}
			if (k.alt) {
				// Kill word forward into the yank buffer (readline alt-d).
				if (cursor < buf.length && !deleteSel()) killRange(cursor, wordRight(buf, cursor))
				return true
			}
			break
		case 'u':
			if (!k.ctrl) break
			{
				// Kill from cursor to start of current line. If already at start
				// of line, kill the preceding newline (joins with previous line).
				const lineStart = buf.lastIndexOf('\n', cursor - 1) + 1
				if (cursor > lineStart) killRange(lineStart, cursor)
				else if (lineStart > 0) killRange(lineStart - 1, cursor)
			}
			return true
		case 'k':
			if (!k.ctrl) break
			{
				// Kill from cursor to end of current line. If cursor is at end of
				// line (on the newline), kill the newline itself.
				let lineEnd = buf.indexOf('\n', cursor)
				if (lineEnd === -1) lineEnd = buf.length
				else if (lineEnd === cursor) lineEnd = cursor + 1
				if (cursor < lineEnd) killRange(cursor, lineEnd)
			}
			return true
		case 'a':
			if (!k.ctrl) break
			moveLineEdge(-1, k.shift)
			return true
		case 'e':
			if (!k.ctrl) break
			moveLineEdge(1, k.shift)
			return true
		case 'v':
			if (!k.ctrl) break
			doPaste()
			return true
		case 'y':
			if (!k.ctrl) break
			yankKillBuffer()
			return true
		case '=':
			if (!k.ctrl || k.alt || k.shift) break
			resizePromptLineLimit(1, contentWidth)
			return true
		case '-':
			if (!k.ctrl || k.alt || k.shift) break
			resizePromptLineLimit(-1, contentWidth)
			return true
		case '/':
			if (!k.ctrl) break
			stepUndo(k.shift)
			return true
		case 'left':
			moveHorizontal(-1, k.shift, k.alt ? 'word' : 'char')
			return true
		case 'right':
			moveHorizontal(1, k.shift, k.alt ? 'word' : 'char')
			return true
		case 'up':
		case 'down': {
			const dir = k.key === 'up' ? -1 : 1
			if (k.ctrl && !k.alt && !k.shift) {
				resizePromptLineLimit(dir === -1 ? 1 : -1, contentWidth)
				return true
			}
			if (k.alt) moveEdge(dir, k.shift)
			else moveVerticalKey(dir, k.shift, contentWidth)
			return true
		}
		case 'home':
			moveLineEdge(-1, k.shift)
			return true
		case 'end':
			moveLineEdge(1, k.shift)
			return true
	}

	if (!k.char) return false
	if (k.char.length === 1 && !selRange()) typeChar(k.char)
	else {
		const text = k.char.length > 1 ? clipboard.cleanPaste(k.char) : k.char
		if (text) replaceSelectionWithPastedText(text)
	}
	return true
}

// ── Rendering ────────────────────────────────────────────────────────────────

interface PromptRender {
	lines: string[]
	cursor: { rowOffset: number; col: number }
	fold: { above: number; below: number }
}

function buildPrompt(contentWidth: number): PromptRender {
	const layout = getLayout(buf, contentWidth)
	const { row: curRow, col: curCol } = cursorToRowCol(buf, cursor, contentWidth)
	const totalRows = Math.max(layout.lines.length, curRow + 1)
	const promptLines = state.promptLineLimit > 0 ? promptLineLimit() : Math.min(totalRows, promptLineLimit())
	const sel = selRange()

	// Keep the prompt viewport stable across cursor moves. Only scroll when the
	// cursor leaves the viewport; ±1 keeps one context row when scrolling is forced.
	let scrollTop = 0
	if (totalRows > promptLines) {
		const maxScrollTop = totalRows - promptLines
		const contextRows = promptLines >= 3 ? 1 : 0
		scrollTop = Math.max(0, Math.min(state.promptScrollTop, maxScrollTop))
		if (curRow < scrollTop) scrollTop = Math.max(0, curRow - contextRows)
		if (curRow >= scrollTop + promptLines) scrollTop = Math.min(maxScrollTop, curRow - promptLines + contextRows + 1)
	}
	state.promptScrollTop = scrollTop

	const lines: string[] = []
	for (let i = scrollTop; i < scrollTop + promptLines; i++) {
		const lineText = layout.lines[i] ?? ''
		const lineStart = layout.starts[i] ?? buf.length
		if (sel) {
			const lo = Math.max(0, sel.start - lineStart)
			const hi = Math.min(lineText.length, sel.end - lineStart)
			if (lo < hi && lo < lineText.length && hi > 0) {
				const expanded = expandTabs(lineText)
				const expandedLo = expandTabs(lineText.slice(0, lo)).length
				const expandedHi = expandTabs(lineText.slice(0, hi)).length
				lines.push(`${expanded.slice(0, expandedLo)}${SELECTION_ON}${expanded.slice(expandedLo, expandedHi)}${SELECTION_OFF}${expanded.slice(expandedHi)}`)
			} else {
				lines.push(expandTabs(lineText))
			}
		} else {
			lines.push(expandTabs(lineText))
		}
	}
	const fold = { above: scrollTop, below: Math.max(0, totalRows - scrollTop - promptLines) }

	return { lines, cursor: { rowOffset: curRow - scrollTop, col: curCol }, fold }
}

function submitText(): string {
	let out = buf
	for (const ref of pasteRefs) {
		out = out.replace(ref.display, ref.text)
	}
	return out
}

// ── Public API ───────────────────────────────────────────────────────────────

function snapshotState(): PromptEditorState {
	return {
		text: buf,
		cursor,
		goalCol,
		selAnchor,
		undoStack: undoStack.map(cloneSnapshot),
		redoStack: redoStack.map(cloneSnapshot),
		undoGrouping,
		history: history.slice(),
		historyIndex,
		historyDraft,
		pasteRefs: pasteRefs.map((ref) => ({ ...ref })),
		promptLineLimit: state.promptLineLimit,
		promptScrollTop: state.promptScrollTop,
	}
}

function restoreState(saved: PromptEditorState): void {
	buf = saved.text
	cursor = clamp(saved.cursor)
	goalCol = saved.goalCol
	selAnchor = saved.selAnchor
	undoStack = saved.undoStack.map(cloneSnapshot)
	redoStack = saved.redoStack.map(cloneSnapshot)
	undoGrouping = saved.undoGrouping
	history = saved.history.slice()
	historyIndex = saved.historyIndex
	historyDraft = saved.historyDraft
	pasteRefs.length = 0
	pasteRefs.push(...saved.pasteRefs.map((ref) => ({ ...ref })))
	state.promptLineLimit = saved.promptLineLimit
	state.promptScrollTop = saved.promptScrollTop ?? 0
}

// The user's own composition text — NOT the history entry they may be
// browsing with up-arrow. This is what gets persisted as a draft.
function draftText(): string {
	if (historyIndex < 0) return buf
	return history[historyIndex] === buf ? historyDraft : buf
}

function isBrowsingHistory(): boolean {
	return historyIndex >= 0
}

function text(): string {
	return buf
}
function cursorPos(): number {
	return cursor
}

function setText(t: string, c?: number): void {
	buf = t
	cursor = c ?? t.length
	clearSelectionAndGoal()
	historyIndex = -1
	historyDraft = ''
	pasteRefs.length = 0
	state.promptScrollTop = 0
}

function clear(): void {
	buf = ''
	cursor = 0
	clearSelectionAndGoal()
	undoStack = []
	redoStack = []
	undoGrouping = false
	historyIndex = -1
	historyDraft = ''
	pasteRefs.length = 0
	state.promptScrollTop = 0
}

function setHistory(h: string[]): void {
	history = h.slice()
	historyIndex = -1
	historyDraft = ''
}
function pushHistory(text: string): void {
	history.push(text)
}
function setRenderCallback(cb: () => void): void {
	renderCallback = cb
}

export const prompt = {
	config,
	state,
	text,
	draftText,
	isBrowsingHistory,
	snapshotState,
	restoreState,
	submitText,
	cursorPos,
	setText,
	clear,
	setHistory,
	pushHistory,
	setRenderCallback,
	handleKey,
	atVerticalBoundary,
	buildPrompt,
	resizeHint,
	promptLineLimit,
}
