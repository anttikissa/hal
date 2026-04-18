// Prompt editing: state, key handling, wrapping, selection, undo, history.
// Merged from previous/ prompt.ts + input.ts.

import { clipboard } from './clipboard.ts'
import type { KeyEvent } from './keys.ts'

const MAX_UNDO = 200

const config = {
	maxPromptLines: 10,
}

// ── Word wrap + cursor mapping ───────────────────────────────────────────────

function wordWrapLines(text: string, width: number): string[] {
	if (width <= 0) return [text]
	const result: string[] = []
	for (const segment of text.split('\n')) {
		let remaining = segment
		while (remaining.length > width) {
			let breakAt = remaining.lastIndexOf(' ', width)
			if (breakAt <= 0) breakAt = width
			result.push(remaining.slice(0, breakAt))
			remaining = remaining[breakAt] === ' ' ? remaining.slice(breakAt + 1) : remaining.slice(breakAt)
		}
		result.push(remaining)
	}
	return result
}

interface WrappedLayout {
	lines: string[]
	starts: number[] // character offset where each wrapped line begins
}

function getLayout(input: string, width: number): WrappedLayout {
	const lines = wordWrapLines(input, width)
	const starts: number[] = []
	let pos = 0
	for (let i = 0; i < lines.length; i++) {
		starts.push(pos)
		const len = lines[i]!.length
		const nextChar = i < lines.length - 1 && pos + len < input.length ? input[pos + len] : ''
		pos += len + (nextChar === ' ' || nextChar === '\n' ? 1 : 0)
	}
	return { lines, starts }
}

function cursorToRowCol(input: string, absPos: number, width: number): { row: number; col: number } {
	const layout = getLayout(input, width)
	const { lines, starts } = layout
	for (let i = 0; i < lines.length; i++) {
		const start = starts[i]!
		const line = lines[i]!
		const nextStart = i < lines.length - 1 ? starts[i + 1]! : input.length
		if (absPos < nextStart) return { row: i, col: Math.min(absPos - start, line.length) }
	}
	const last = lines.length - 1
	if (width > 0 && absPos === input.length && (lines[last]?.length ?? 0) === width && !input.endsWith('\n')) {
		return { row: last + 1, col: 0 }
	}
	return { row: last, col: lines[last]?.length ?? 0 }
}


function rowColToCursor(input: string, row: number, col: number, width: number): number {
	const { lines, starts } = getLayout(input, width)
	if (lines.length === 0) return 0
	const r = Math.max(0, Math.min(row, lines.length - 1))
	return starts[r]! + Math.max(0, Math.min(col, lines[r]!.length))
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

// Cmd+Left/Right on macOS should move by the next word token, not by a whole
// whitespace-delimited chunk. In `(paren)`, moving left from the end should
// land between `(` and `paren`, skipping closing punctuation first.
function isWordTokenChar(ch: string): boolean {
	return /[\p{L}\p{N}\p{M}_]/u.test(ch)
}

function cmdWordLeft(text: string, pos: number): number {
	let i = pos
	while (i > 0 && !isWordTokenChar(text[i - 1]!)) i--
	while (i > 0 && isWordTokenChar(text[i - 1]!)) i--
	return i
}

function cmdWordRight(text: string, pos: number): number {
	let i = pos
	while (i < text.length && !isWordTokenChar(text[i]!)) i++
	while (i < text.length && isWordTokenChar(text[i]!)) i++
	return i
}

// ── State ────────────────────────────────────────────────────────────────────

let buf = ''
let cursor = 0
let goalCol: number | null = null
let selAnchor: number | null = null

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

// Called when async paste resolves (image placeholder -> path)
let renderCallback: (() => void) | null = null

// ── Helpers ──────────────────────────────────────────────────────────────────

function clamp(pos: number): number {
	return Math.max(0, Math.min(pos, buf.length))
}

function clearSelectionAndGoal(): void {
	selAnchor = null
	goalCol = null
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

function loadHistoryText(text: string): void {
	buf = text
	cursor = buf.length
	clearSelectionAndGoal()
}

function browseHistory(dir: -1 | 1): boolean {
	if (history.length === 0) return false
	if (dir === -1) {
		if (historyIndex < 0) {
			historyDraft = buf
			historyIndex = history.length - 1
		} else if (historyIndex > 0) {
			historyIndex--
		} else {
			moveEdge(-1, false)
			return true
		}
		loadHistoryText(history[historyIndex]!)
		return true
	}
	if (historyIndex < 0) {
		moveEdge(1, false)
		return true
	}
	if (historyIndex < history.length - 1) {
		historyIndex++
		loadHistoryText(history[historyIndex]!)
		return true
	}
	historyIndex = -1
	loadHistoryText(historyDraft)
	historyDraft = ''
	return true
}

// ── Mutations ────────────────────────────────────────────────────────────────

function replaceSelection(text: string): void {
	pushUndo()
	applyInsertion(text)
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

function moveHorizontal(dir: -1 | 1, selecting: boolean, motion: 'char' | 'word' | 'cmd-word' = 'char'): void {
	const pos = motion === 'word'
		? dir === -1 ? wordLeft(buf, cursor) : wordRight(buf, cursor)
		: motion === 'cmd-word'
			? dir === -1 ? cmdWordLeft(buf, cursor) : cmdWordRight(buf, cursor)
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
	const t = clipboard.cleanPaste(
		clipboard.pasteFromClipboard((ph, result) => {
			resolvePlaceholder(ph, result)
		}),
	)
	if (t) replaceSelection(t)
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
	if (!selecting && browseHistory(dir)) return
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
			moveHorizontal(-1, k.shift, 'cmd-word')
			return true
		case 'right':
			moveHorizontal(1, k.shift, 'cmd-word')
			return true
		case 'u':
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
		case 'backspace':
			deleteBackward(k.alt)
			return true
		case 'delete':
			deleteForward()
			return true
		case 'd':
			if (!k.ctrl) break
			if (buf.length === 0) return false
			deleteForward()
			return true
		case 'u':
			if (!k.ctrl) break
			if (cursor > 0) deleteRange(0, cursor)
			return true
		case 'k':
			if (!k.ctrl) break
			if (cursor < buf.length) deleteRange(cursor, buf.length)
			return true
		case 'a':
			if (!k.ctrl) break
			moveEdge(-1, k.shift)
			return true
		case 'e':
			if (!k.ctrl) break
			moveEdge(1, k.shift)
			return true
		case 'v':
		case 'y':
			if (!k.ctrl) break
			doPaste()
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
			if (k.alt) moveEdge(dir, k.shift)
			else moveVerticalKey(dir, k.shift, contentWidth)
			return true
		}
		case 'home':
			moveEdge(-1, k.shift)
			return true
		case 'end':
			moveEdge(1, k.shift)
			return true
	}

	if (!k.char) return false
	if (k.char.length === 1 && !selRange()) typeChar(k.char)
	else {
		const text = k.char.length > 1 ? clipboard.cleanPaste(k.char) : k.char
		if (text) replaceSelection(text)
	}
	return true
}

// ── Rendering ────────────────────────────────────────────────────────────────

interface PromptRender {
	lines: string[]
	cursor: { rowOffset: number; col: number }
}

function buildPrompt(contentWidth: number): PromptRender {
	const layout = getLayout(buf, contentWidth)
	const { row: curRow, col: curCol } = cursorToRowCol(buf, cursor, contentWidth)
	const totalRows = Math.max(layout.lines.length, curRow + 1)
	const promptLines = Math.min(totalRows, config.maxPromptLines)
	const sel = selRange()

	// Scroll viewport if prompt is taller than MAX_PROMPT_LINES
	let scrollTop = 0
	if (totalRows > promptLines) {
		scrollTop = Math.min(curRow, totalRows - promptLines)
		scrollTop = Math.max(scrollTop, curRow - promptLines + 1)
	}

	const lines: string[] = []
	for (let i = scrollTop; i < scrollTop + promptLines; i++) {
		const lineText = layout.lines[i] ?? ''
		const lineStart = layout.starts[i] ?? buf.length
		if (sel) {
			const lo = Math.max(0, sel.start - lineStart)
			const hi = Math.min(lineText.length, sel.end - lineStart)
			if (lo < hi && lo < lineText.length && hi > 0) {
				lines.push(`${lineText.slice(0, lo)}\x1b[7m${lineText.slice(lo, hi)}\x1b[0m${lineText.slice(hi)}`)
			} else {
				lines.push(lineText)
			}
		} else {
			lines.push(lineText)
		}
	}

	return { lines, cursor: { rowOffset: curRow - scrollTop, col: curCol } }
}

// ── Public API ───────────────────────────────────────────────────────────────

// The user's own composition text — NOT the history entry they may be
// browsing with up-arrow. This is what gets persisted as a draft.
function draftText(): string {
	return historyIndex < 0 ? buf : historyDraft
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
}

function setHistory(h: string[]): void {
	history = h
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
	text,
	draftText,
	cursorPos,
	setText,
	clear,
	setHistory,
	pushHistory,
	setRenderCallback,
	handleKey,
	buildPrompt,
}
