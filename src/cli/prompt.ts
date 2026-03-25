// Prompt editing: state, key handling, wrapping, selection, undo, history.
// Merged from previous/ prompt.ts + input.ts.

import { clipboard } from './clipboard.ts'
import type { KeyEvent } from './keys.ts'

const MAX_PROMPT_LINES = 12
const MAX_UNDO = 200

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
	const { lines, starts } = getLayout(input, width)
	for (let i = 0; i < lines.length; i++) {
		if (absPos <= starts[i]! + lines[i]!.length) {
			return { row: i, col: absPos - starts[i]! }
		}
	}
	const last = lines.length - 1
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

// ── Mutations ────────────────────────────────────────────────────────────────

function replaceSelection(text: string): void {
	pushUndo()
	const sel = selRange()
	if (sel) {
		buf = buf.slice(0, sel.start) + text + buf.slice(sel.end)
		cursor = sel.start + text.length
	} else {
		buf = buf.slice(0, cursor) + text + buf.slice(cursor)
		cursor += text.length
	}
	selAnchor = null
	goalCol = null
}

// Single char insert — consecutive inserts coalesce into one undo group
function typeChar(ch: string): void {
	if (!undoGrouping) pushUndo()
	undoGrouping = true
	const sel = selRange()
	if (sel) {
		buf = buf.slice(0, sel.start) + ch + buf.slice(sel.end)
		cursor = sel.start + ch.length
	} else {
		buf = buf.slice(0, cursor) + ch + buf.slice(cursor)
		cursor += ch.length
	}
	selAnchor = null
	goalCol = null
}

function deleteRange(start: number, end: number): void {
	pushUndo()
	buf = buf.slice(0, start) + buf.slice(end)
	cursor = start
	selAnchor = null
	goalCol = null
}

function deleteSel(): boolean {
	const sel = selRange()
	if (!sel) return false
	deleteRange(sel.start, sel.end)
	return true
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

// Collapse selection to one edge, or move if no selection
function collapseOrMove(pos: number, edge: 'start' | 'end'): void {
	const sel = selRange()
	if (sel) {
		cursor = edge === 'start' ? sel.start : sel.end
		selAnchor = null
		goalCol = null
	} else {
		move(pos, false)
	}
}

function undo(): boolean {
	undoGrouping = false
	const snap = undoStack.pop()
	if (!snap) return false
	redoStack.push({ text: buf, cursor, selAnchor })
	buf = snap.text
	cursor = clamp(snap.cursor)
	selAnchor = snap.selAnchor
	goalCol = null
	return true
}

function redo(): boolean {
	undoGrouping = false
	const snap = redoStack.pop()
	if (!snap) return false
	undoStack.push({ text: buf, cursor, selAnchor })
	buf = snap.text
	cursor = clamp(snap.cursor)
	selAnchor = snap.selAnchor
	goalCol = null
	return true
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

function handleKey(k: KeyEvent, contentWidth: number): boolean {
	// Any non-single-char key breaks the typing undo group
	if (!(k.char && k.char.length === 1 && !k.ctrl && !k.alt && !k.cmd)) undoGrouping = false

	// Cmd shortcuts (macOS)
	if (k.cmd) {
		if (k.key === 'c') {
			const s = selRange()
			if (s) writeToClipboard(buf.slice(s.start, s.end))
			return true
		}
		if (k.key === 'x') {
			const s = selRange()
			if (s) {
				writeToClipboard(buf.slice(s.start, s.end))
				deleteRange(s.start, s.end)
			}
			return true
		}
		if (k.key === 'v') {
			doPaste()
			return true
		}
		if (k.key === 'a') {
			selAnchor = 0
			cursor = buf.length
			return true
		}
		if (k.key === 'u' && k.shift) {
			redo()
			return true
		}
		if (k.key === 'u') {
			undo()
			return true
		}
		return false
	}

	// Enter: shift+enter inserts newline; plain enter goes to keybindings (submit)
	if (k.key === 'enter' && k.shift && !k.alt) {
		replaceSelection('\n')
		return true
	}
	if (k.key === 'enter') return false

	// Backspace / Delete
	if (k.key === 'backspace') {
		if (k.alt) {
			if (!deleteSel() && cursor > 0) deleteRange(wordLeft(buf, cursor), cursor)
		} else {
			if (!deleteSel() && cursor > 0) deleteRange(cursor - 1, cursor)
		}
		return true
	}
	if (k.key === 'delete') {
		if (!deleteSel() && cursor < buf.length) deleteRange(cursor, cursor + 1)
		return true
	}

	// Ctrl+D: delete forward (return false when empty so cli can handle it)
	if (k.key === 'd' && k.ctrl) {
		if (buf.length === 0) return false
		if (!deleteSel() && cursor < buf.length) deleteRange(cursor, cursor + 1)
		return true
	}

	// Ctrl+U/K: kill line
	if (k.key === 'u' && k.ctrl) {
		if (cursor > 0) deleteRange(0, cursor)
		return true
	}
	if (k.key === 'k' && k.ctrl) {
		if (cursor < buf.length) deleteRange(cursor, buf.length)
		return true
	}

	// Ctrl+A/E: home/end (Emacs)
	if (k.key === 'a' && k.ctrl) {
		move(0, k.shift)
		return true
	}
	if (k.key === 'e' && k.ctrl) {
		move(buf.length, k.shift)
		return true
	}

	// Ctrl+V/Y: paste
	if ((k.key === 'v' || k.key === 'y') && k.ctrl) {
		doPaste()
		return true
	}

	// Ctrl+/: undo, Shift+Ctrl+/: redo
	if (k.key === '/' && k.ctrl && k.shift) {
		redo()
		return true
	}
	if (k.key === '/' && k.ctrl) {
		undo()
		return true
	}

	// Left / Right
	if (k.key === 'left') {
		if (k.alt) {
			move(wordLeft(buf, cursor), k.shift)
			return true
		}
		if (k.shift) {
			move(cursor - 1, true)
			return true
		}
		collapseOrMove(cursor - 1, 'start')
		return true
	}
	if (k.key === 'right') {
		if (k.alt) {
			move(wordRight(buf, cursor), k.shift)
			return true
		}
		if (k.shift) {
			move(cursor + 1, true)
			return true
		}
		collapseOrMove(cursor + 1, 'end')
		return true
	}

	// Up / Down: vertical move in wrapped text, history at boundaries
	if (k.key === 'up' || k.key === 'down') {
		const dir = k.key === 'up' ? -1 : 1
		if (k.alt) {
			move(dir === -1 ? 0 : buf.length, k.shift)
			return true
		}

		if (!k.shift) {
			const r = verticalMove(buf, contentWidth, cursor, goalCol, dir)
			if (!r.atBoundary) {
				selAnchor = null
				cursor = r.cursor
				goalCol = r.goalCol
				return true
			}
			// At boundary: cycle history
			if (history.length > 0) {
				if (dir === -1) {
					if (historyIndex < 0) {
						historyDraft = buf
						historyIndex = history.length - 1
					} else if (historyIndex > 0) {
						historyIndex--
					} else {
						cursor = 0
						goalCol = null
						selAnchor = null
						return true
					}
					buf = history[historyIndex]!
					cursor = buf.length
					goalCol = null
					selAnchor = null
				} else {
					if (historyIndex < 0) {
						cursor = buf.length
						goalCol = null
						selAnchor = null
						return true
					}
					if (historyIndex < history.length - 1) {
						historyIndex++
						buf = history[historyIndex]!
					} else {
						historyIndex = -1
						buf = historyDraft
						historyDraft = ''
					}
					cursor = buf.length
					goalCol = null
					selAnchor = null
				}
				return true
			}
			cursor = dir === -1 ? 0 : buf.length
			goalCol = null
			selAnchor = null
		} else {
			if (selAnchor === null) selAnchor = cursor
			const r = verticalMove(buf, contentWidth, cursor, goalCol, dir)
			if (!r.atBoundary) {
				cursor = r.cursor
				goalCol = r.goalCol
			} else {
				cursor = dir === -1 ? 0 : buf.length
				goalCol = null
			}
		}
		return true
	}

	// Home / End
	if (k.key === 'home') {
		move(0, k.shift)
		return true
	}
	if (k.key === 'end') {
		move(buf.length, k.shift)
		return true
	}

	// Printable
	if (k.char) {
		if (k.char.length === 1 && !selRange()) {
			typeChar(k.char)
		} else {
			const text = k.char.length > 1 ? clipboard.cleanPaste(k.char) : k.char
			if (text) replaceSelection(text)
		}
		return true
	}

	return false
}

// ── Rendering ────────────────────────────────────────────────────────────────

interface PromptRender {
	lines: string[]
	cursor: { rowOffset: number; col: number }
}

function buildPrompt(contentWidth: number): PromptRender {
	const layout = getLayout(buf, contentWidth)
	const promptLines = Math.min(layout.lines.length, MAX_PROMPT_LINES)
	const { row: curRow, col: curCol } = cursorToRowCol(buf, cursor, contentWidth)
	const sel = selRange()

	// Scroll viewport if prompt is taller than MAX_PROMPT_LINES
	let scrollTop = 0
	if (layout.lines.length > promptLines) {
		scrollTop = Math.min(curRow, layout.lines.length - promptLines)
		scrollTop = Math.max(scrollTop, curRow - promptLines + 1)
	}

	const lines: string[] = []
	for (let i = scrollTop; i < scrollTop + promptLines; i++) {
		const lineText = layout.lines[i] ?? ''
		const lineStart = layout.starts[i] ?? 0
		if (sel) {
			const lo = Math.max(0, sel.start - lineStart)
			const hi = Math.min(lineText.length, sel.end - lineStart)
			if (lo < hi && lo < lineText.length && hi > 0) {
				lines.push(` ${lineText.slice(0, lo)}\x1b[7m${lineText.slice(lo, hi)}\x1b[0m${lineText.slice(hi)}`)
			} else {
				lines.push(` ${lineText}`)
			}
		} else {
			lines.push(` ${lineText}`)
		}
	}

	// +1 for the single-space prefix on each line
	return { lines, cursor: { rowOffset: curRow - scrollTop, col: curCol + 1 } }
}

// ── Draft save/restore ───────────────────────────────────────────────────────
// When switching tabs, save the current prompt text so it's restored when
// the user switches back. Drafts are keyed by session ID and stored in memory.

const drafts = new Map<string, string>()

function saveDraft(sessionId: string): void {
	if (buf) {
		drafts.set(sessionId, buf)
	} else {
		drafts.delete(sessionId)
	}
}

function restoreDraft(sessionId: string): void {
	const saved = drafts.get(sessionId) ?? ''
	buf = saved
	cursor = saved.length
	goalCol = null
	selAnchor = null
	historyIndex = -1
	historyDraft = ''
}

// ── Public API ───────────────────────────────────────────────────────────────

function text(): string {
	return buf
}
function cursorPos(): number {
	return cursor
}

function setText(t: string, c?: number): void {
	buf = t
	cursor = c ?? t.length
	goalCol = null
	selAnchor = null
	historyIndex = -1
	historyDraft = ''
}

function clear(): void {
	buf = ''
	cursor = 0
	goalCol = null
	selAnchor = null
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
function lineCount(w: number): number {
	return Math.min(getLayout(buf, w).lines.length, MAX_PROMPT_LINES)
}

export const prompt = {
	text,
	cursorPos,
	setText,
	clear,
	setHistory,
	pushHistory,
	setRenderCallback,
	handleKey,
	buildPrompt,
	lineCount,
	saveDraft,
	restoreDraft,
}
