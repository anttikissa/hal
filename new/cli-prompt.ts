// Prompt area: state, key handling, and line building.

import type { CursorPos } from './cli-diff-engine.ts'
import type { KeyEvent } from './cli-keys.ts'
import { getWrappedInputLayout, cursorToWrappedRowCol, verticalMove, wordBoundaryLeft, wordBoundaryRight } from './cli-input.ts'

const DIM = '\x1b[2m', RESET = '\x1b[0m'
const SEL_ON = '\x1b[7m', SEL_OFF = '\x1b[27m' // reverse video
const MAX_PROMPT_LINES = 12

// ── State ──

let buf = ''
let cursor = 0
let goalCol: number | null = null
let selAnchor: number | null = null // null = no selection

export function text(): string { return buf }

export function reset(): void {
	buf = ''
	cursor = 0
	goalCol = null
	selAnchor = null
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

function writeClipboard(text: string): void {
	if (!text) return
	try { const p = Bun.spawn(['pbcopy'], { stdin: 'pipe' }); p.stdin.write(text); p.stdin.end() } catch {}
}

function readClipboard(): string {
	try { return Bun.spawnSync(['pbpaste']).stdout.toString() } catch { return '' }
}

// ── Key handling ──
// Returns true if the key was handled.

export function handleKey(k: KeyEvent, contentWidth: number): boolean {
	// Cmd shortcuts
	if (k.cmd) {
		if (k.key === 'c') { const s = selRange(); if (s) writeClipboard(buf.slice(s.start, s.end)); return true }
		if (k.key === 'x') { const s = selRange(); if (s) { writeClipboard(buf.slice(s.start, s.end)); deleteRange(s.start, s.end) }; return true }
		if (k.key === 'v') { const t = readClipboard().replace(/\r\n/g, '\n').replace(/\r/g, '\n'); if (t) replaceSelection(t); return true }
		if (k.key === 'a') { selAnchor = 0; cursor = buf.length; return true }
		return false
	}

	// Enter
	if (k.key === 'enter' && k.alt) { replaceSelection('\n'); return true }
	if (k.key === 'enter') return false // let cli.ts handle submit

	// Backspace
	if (k.key === 'backspace') {
		if (k.alt) {
			if (!deleteSel() && cursor > 0) deleteRange(wordBoundaryLeft(buf, cursor), cursor)
		} else {
			if (!deleteSel() && cursor > 0) deleteRange(cursor - 1, cursor)
		}
		return true
	}
	if (k.key === 'delete') {
		if (!deleteSel() && cursor < buf.length) deleteRange(cursor, cursor + 1)
		return true
	}
	// Ctrl+D: delete forward, but return false when empty (cli.ts closes tab)
	if (k.key === 'd' && k.ctrl) {
		if (buf.length === 0) return false
		if (!deleteSel() && cursor < buf.length) deleteRange(cursor, cursor + 1)
		return true
	}

	// Ctrl+U: delete to start of line, Ctrl+K: delete to end
	if (k.key === 'u' && k.ctrl) { if (cursor > 0) deleteRange(0, cursor); return true }
	if (k.key === 'k' && k.ctrl) { if (cursor < buf.length) deleteRange(cursor, buf.length); return true }

	// Ctrl+A: select all
	if (k.key === 'a' && k.ctrl) { selAnchor = 0; cursor = buf.length; return true }

	// Left / Right
	if (k.key === 'left') {
		if (k.alt) { move(k.shift ? wordBoundaryLeft(buf, cursor) : wordBoundaryLeft(buf, cursor), k.shift); return true }
		if (k.shift) { move(cursor - 1, true); return true }
		collapseOrMove(cursor - 1, 'start'); return true
	}
	if (k.key === 'right') {
		if (k.alt) { move(wordBoundaryRight(buf, cursor), k.shift); return true }
		if (k.shift) { move(cursor + 1, true); return true }
		collapseOrMove(cursor + 1, 'end'); return true
	}

	// Up / Down
	if (k.key === 'up' || k.key === 'down') {
		const dir = k.key === 'up' ? -1 : 1
		if (k.alt) { move(dir === -1 ? 0 : buf.length, k.shift); return true }
		if (k.shift) {
			if (selAnchor === null) selAnchor = cursor
		} else {
			selAnchor = null
		}
		const r = verticalMove(buf, contentWidth, cursor, goalCol, dir)
		if (!r.atBoundary) { cursor = r.cursor; goalCol = r.goalCol }
		return true
	}

	// Home / End
	if (k.key === 'home') { move(0, k.shift); return true }
	if (k.key === 'end') { move(buf.length, k.shift); return true }

	// Printable characters
	if (k.char) { replaceSelection(k.char); return true }

	return false
}

// ── Rendering ──

export interface PromptRender {
	separator: string
	lines: string[]
	cursor: { rowOffset: number; col: number }
}

/** Build prompt lines. Returns separator, content lines, and cursor offset within them. */
export function buildPrompt(width: number, contentWidth: number): PromptRender {
	const layout = getWrappedInputLayout(buf, contentWidth)
	const promptLines = Math.min(layout.lines.length, MAX_PROMPT_LINES)
	const { row: curRow, col: curCol } = cursorToWrappedRowCol(buf, cursor, contentWidth)
	const sel = selRange()

	// Scroll window
	let scrollTop = 0
	if (layout.lines.length > promptLines) {
		scrollTop = Math.min(curRow, layout.lines.length - promptLines)
		scrollTop = Math.max(scrollTop, curRow - promptLines + 1)
	}
	const aboveCount = scrollTop
	const belowCount = Math.max(0, layout.lines.length - scrollTop - promptLines)

	// Separator with scroll indicators
	let sep: string
	if (aboveCount > 0 || belowCount > 0) {
		const parts: string[] = []
		if (aboveCount > 0) parts.push(`↑${aboveCount}`)
		if (belowCount > 0) parts.push(`↓${belowCount}`)
		const label = ` ${parts.join(' ')} `
		sep = `${DIM}${'─'.repeat(Math.max(0, width - label.length))}${label}${RESET}`
	} else {
		sep = `${DIM}${'─'.repeat(width)}${RESET}`
	}

	// Prompt lines with 1-char padding and selection highlight
	const lines: string[] = []
	for (let i = scrollTop; i < scrollTop + promptLines; i++) {
		const lineText = layout.lines[i] ?? ''
		const lineStart = layout.starts[i] ?? 0
		if (sel) {
			lines.push(` ${highlightSel(lineText, lineStart, sel.start, sel.end)}`)
		} else {
			lines.push(` ${lineText}`)
		}
	}

	return {
		separator: sep,
		lines,
		cursor: { rowOffset: curRow - scrollTop, col: curCol + 2 },
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
	return Math.min(getWrappedInputLayout(buf, contentWidth).lines.length, MAX_PROMPT_LINES)
}
