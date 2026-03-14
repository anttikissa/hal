// Prompt area: state, key handling, and line building.

import { SEL_ON, SEL_OFF } from './colors.ts'
import { clipboard } from './clipboard.ts'
import type { KeyEvent } from './keys.ts'
import { input } from './input.ts'
const MAX_PROMPT_LINES = 12

// ── State ──

let buf = ''
let cursor = 0
let goalCol: number | null = null
let selAnchor: number | null = null // null = no selection

// ── History ──

let history: string[] = []
let historyIndex = -1 // -1 = editing draft, 0..n = browsing history (0 = newest)
let historyDraft = '' // saved draft when entering history mode

// ── Question mode ──
// When a question is active, the main prompt state is saved and buf/cursor
// are used for the question answer. On clearQuestion(), main state is restored.

let questionLabel: string | null = null
let savedMain: { buf: string; cursor: number; goalCol: number | null; selAnchor: number | null; history: string[]; historyIndex: number; historyDraft: string } | null = null

export function setQuestion(label: string): void {
	savedMain = { buf, cursor, goalCol, selAnchor, history, historyIndex, historyDraft }
	questionLabel = label
	buf = ''
	cursor = 0
	goalCol = null
	selAnchor = null
	history = []
	historyIndex = -1
	historyDraft = ''
}

export function clearQuestion(): string {
	const answer = buf
	if (savedMain) {
		buf = savedMain.buf
		cursor = savedMain.cursor
		goalCol = savedMain.goalCol
		selAnchor = savedMain.selAnchor
		history = savedMain.history
		historyIndex = savedMain.historyIndex
		historyDraft = savedMain.historyDraft
		savedMain = null
	}
	questionLabel = null
	return answer
}

export function hasQuestion(): boolean { return questionLabel !== null }
export function getQuestionLabel(): string | null { return questionLabel }
/** The frozen main prompt text (shown grayed out during question mode). */
export function frozenText(): string | null { return savedMain?.buf ?? null }

export function setHistory(h: string[]): void { history = h; historyIndex = -1; historyDraft = '' }
export function pushHistory(text: string): void { history.push(text) }

export function text(): string { return buf }
export function cursorPos(): number { return cursor }
export function selection(): [number, number] | null {
	if (selAnchor === null) return null
	return selAnchor < cursor ? [selAnchor, cursor] : [cursor, selAnchor]
}

export function setText(t: string, c?: number): void {
	buf = t
	cursor = c ?? t.length
	goalCol = null
	selAnchor = null
	historyIndex = -1
	historyDraft = ''
}

/** Clear input buffer only, preserving history. */
export function clear(): void {
	buf = ''
	cursor = 0
	goalCol = null
	selAnchor = null
	historyIndex = -1
	historyDraft = ''
}

/** Full reset — clears buffer, history, and question state. */
export function reset(): void {
	clear()
	history = []
	questionLabel = null
	savedMain = null
}

function selRange(): { start: number; end: number } | null {
	if (selAnchor === null) return null
	const lo = Math.min(selAnchor, cursor)
	const hi = Math.max(selAnchor, cursor)
	return lo === hi ? null : { start: lo, end: hi }
}

// ── Editing ──

function clamp(pos: number): number { return Math.max(0, Math.min(pos, buf.length)) }

function replaceSelection(text: string): void {
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

function deleteRange(start: number, end: number): void {
	buf = buf.slice(0, start) + buf.slice(end)
	cursor = start
	selAnchor = null
	goalCol = null
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

function deleteSel(): boolean {
	const sel = selRange()
	if (!sel) return false
	deleteRange(sel.start, sel.end)
	return true
}

// ── Clipboard ──

let renderCallback: (() => void) | null = null
export function setRenderCallback(cb: () => void): void { renderCallback = cb }

function writeClipboard(text: string): void {
	if (!text) return
	try { const p = Bun.spawn(['pbcopy'], { stdin: 'pipe' }); p.stdin.write(text); p.stdin.end() } catch {}
}

function resolvePlaceholder(placeholder: string, replacement: string): void {
	const idx = buf.lastIndexOf(placeholder)
	if (idx < 0) return
	buf = buf.slice(0, idx) + replacement + buf.slice(idx + placeholder.length)
	// Adjust cursor if it was after the placeholder
	if (cursor > idx) cursor += replacement.length - placeholder.length
	cursor = clamp(cursor)
	renderCallback?.()
}

function doPaste(): void {
	const t = clipboard.cleanPaste(clipboard.pasteFromClipboard((placeholder, result) => {
		resolvePlaceholder(placeholder, result)
	}))
	if (t) replaceSelection(t)
}

// ── Key handling ──
// Returns true if the key was handled.

export function handleKey(k: KeyEvent, contentWidth: number): boolean {
	// Cmd shortcuts
	if (k.cmd) {
		if (k.key === 'c') { const s = selRange(); if (s) writeClipboard(buf.slice(s.start, s.end)); return true }
		if (k.key === 'x') { const s = selRange(); if (s) { writeClipboard(buf.slice(s.start, s.end)); deleteRange(s.start, s.end) }; return true }
		if (k.key === 'v') { doPaste(); return true }
		if (k.key === 'a') { selAnchor = 0; cursor = buf.length; return true }
		return false
	}

	// Enter
	if (k.key === 'enter' && (k.alt || k.shift)) { replaceSelection('\n'); return true }
	if (k.key === 'enter') return false // let cli/cli.ts handle submit

	// Backspace
	if (k.key === 'backspace') {
		if (k.alt) {
			if (!deleteSel() && cursor > 0) deleteRange(input.wordBoundaryLeft(buf, cursor), cursor)
		} else {
			if (!deleteSel() && cursor > 0) deleteRange(cursor - 1, cursor)
		}
		return true
	}
	if (k.key === 'delete') {
		if (!deleteSel() && cursor < buf.length) deleteRange(cursor, cursor + 1)
		return true
	}
	// Ctrl+D: delete forward, but return false when empty (cli/cli.ts closes tab)
	if (k.key === 'd' && k.ctrl) {
		if (buf.length === 0) return false
		if (!deleteSel() && cursor < buf.length) deleteRange(cursor, cursor + 1)
		return true
	}

	// Ctrl+U: delete to start of line, Ctrl+K: delete to end
	if (k.key === 'u' && k.ctrl) { if (cursor > 0) deleteRange(0, cursor); return true }
	if (k.key === 'k' && k.ctrl) { if (cursor < buf.length) deleteRange(cursor, buf.length); return true }

	// Ctrl+A/E: Home/End (Emacs)
	if (k.key === 'a' && k.ctrl) { move(0, k.shift); return true }
	if (k.key === 'e' && k.ctrl) { move(buf.length, k.shift); return true }

	// Ctrl+V / Ctrl+Y: paste (same as Cmd+V)
	if ((k.key === 'v' || k.key === 'y') && k.ctrl) { doPaste(); return true }

	// Left / Right
	if (k.key === 'left') {
		if (k.alt) { move(k.shift ? input.wordBoundaryLeft(buf, cursor) : input.wordBoundaryLeft(buf, cursor), k.shift); return true }
		if (k.shift) { move(cursor - 1, true); return true }
		collapseOrMove(cursor - 1, 'start'); return true
	}
	if (k.key === 'right') {
		if (k.alt) { move(input.wordBoundaryRight(buf, cursor), k.shift); return true }
		if (k.shift) { move(cursor + 1, true); return true }
		collapseOrMove(cursor + 1, 'end'); return true
	}

	// Up / Down — vertical move within text, history at boundaries
	if (k.key === 'up' || k.key === 'down') {
		const dir = k.key === 'up' ? -1 : 1
		if (k.alt) { move(dir === -1 ? 0 : buf.length, k.shift); return true }

		// Try vertical move first (multi-line input)
		if (!k.shift) {
			const r = input.verticalMove(buf, contentWidth, cursor, goalCol, dir)
			if (!r.atBoundary) {
				selAnchor = null
				cursor = r.cursor; goalCol = r.goalCol
				return true
			}

			// At boundary → cycle history or move to line boundary
			if (history.length > 0) {
				if (dir === -1) {
					if (historyIndex < 0) {
						historyDraft = buf
						historyIndex = history.length - 1
					} else if (historyIndex > 0) {
						historyIndex--
					} else {
						cursor = 0; goalCol = null; selAnchor = null
						return true
					}
					buf = history[historyIndex]
					cursor = buf.length; goalCol = null; selAnchor = null
				} else {
					if (historyIndex < 0) {
						cursor = buf.length; goalCol = null; selAnchor = null
						return true
					}
					if (historyIndex < history.length - 1) {
						historyIndex++
						buf = history[historyIndex]
					} else {
						historyIndex = -1
						buf = historyDraft; historyDraft = ''
					}
					cursor = buf.length; goalCol = null; selAnchor = null
				}
				return true
			}
			cursor = dir === -1 ? 0 : buf.length; goalCol = null; selAnchor = null
		} else {
			if (selAnchor === null) selAnchor = cursor
			const r = input.verticalMove(buf, contentWidth, cursor, goalCol, dir)
			if (!r.atBoundary) { cursor = r.cursor; goalCol = r.goalCol }
			else { cursor = dir === -1 ? 0 : buf.length; goalCol = null }
		}
		return true
	}

	// Home / End
	if (k.key === 'home') { move(0, k.shift); return true }
	if (k.key === 'end') { move(buf.length, k.shift); return true }

	// Printable characters (multi-char from bracketed paste goes through cleanPaste)
	if (k.char) {
		const text = k.char.length > 1 ? clipboard.cleanPaste(k.char) : k.char
		if (text) replaceSelection(text)
		return true
	}

	return false
}

// ── Rendering ──

export interface PromptRender {
	lines: string[]
	cursor: { rowOffset: number; col: number }
	scrollInfo?: string
}

/** Build prompt lines and cursor offset. */
export function buildPrompt(contentWidth: number): PromptRender {
	const layout = input.getWrappedInputLayout(buf, contentWidth)
	const promptLines = Math.min(layout.lines.length, MAX_PROMPT_LINES)
	const { row: curRow, col: curCol } = input.cursorToWrappedRowCol(buf, cursor, contentWidth)
	const sel = selRange()

	let scrollTop = 0
	if (layout.lines.length > promptLines) {
		scrollTop = Math.min(curRow, layout.lines.length - promptLines)
		scrollTop = Math.max(scrollTop, curRow - promptLines + 1)
	}
	const aboveCount = scrollTop
	const belowCount = Math.max(0, layout.lines.length - scrollTop - promptLines)

	let scrollInfo: string | undefined
	if (aboveCount > 0 || belowCount > 0) {
		const parts: string[] = []
		if (aboveCount > 0) parts.push(`↑${aboveCount}`)
		if (belowCount > 0) parts.push(`↓${belowCount}`)
		scrollInfo = parts.join(' ')
	}

	const lines: string[] = []
	for (let i = scrollTop; i < scrollTop + promptLines; i++) {
		const lineText = layout.lines[i] ?? ''
		const lineStart = layout.starts[i] ?? 0
		if (sel) lines.push(` ${highlightSel(lineText, lineStart, sel.start, sel.end)}`)
		else lines.push(` ${lineText}`)
	}

	return {
		lines,
		cursor: { rowOffset: curRow - scrollTop, col: curCol + 2 },
		scrollInfo,
	}
}

function highlightSel(line: string, lineStart: number, selStart: number, selEnd: number): string {
	const lo = Math.max(0, selStart - lineStart)
	const hi = Math.min(line.length, selEnd - lineStart)
	if (lo >= hi || lo >= line.length || hi <= 0) return line
	return line.slice(0, lo) + SEL_ON + line.slice(lo, hi) + SEL_OFF + line.slice(hi)
}

/** Number of visible prompt lines for current input. */
export function lineCount(contentWidth: number): number {
	return Math.min(input.getWrappedInputLayout(buf, contentWidth).lines.length, MAX_PROMPT_LINES)
}

export const prompt = {
	setQuestion,
	clearQuestion,
	hasQuestion,
	getQuestionLabel,
	frozenText,
	setHistory,
	pushHistory,
	text,
	cursorPos,
	selection,
	setText,
	clear,
	reset,
	setRenderCallback,
	handleKey,
	buildPrompt,
	lineCount,
}
