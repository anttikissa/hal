// Prompt area: state, key handling, and line building.

import type { CursorPos } from './cli-render.ts'
import { getWrappedInputLayout, cursorToWrappedRowCol, verticalMove, wordBoundaryLeft, wordBoundaryRight } from './cli-input.ts'

const DIM = '\x1b[2m', RESET = '\x1b[0m'
const MAX_PROMPT_LINES = 12

// ── State ──

let buf = ''
let cursor = 0
let goalCol: number | null = null

export function text(): string { return buf }

export function reset(): void {
	buf = ''
	cursor = 0
	goalCol = null
}

// ── Editing ──

function clamp(pos: number): number { return Math.max(0, Math.min(pos, buf.length)) }

function insertAt(text: string): void {
	buf = buf.slice(0, cursor) + text + buf.slice(cursor)
	cursor += text.length
	goalCol = null
}

function deleteRange(start: number, end: number): void {
	buf = buf.slice(0, start) + buf.slice(end)
	cursor = start
	goalCol = null
}

function move(pos: number): void {
	cursor = clamp(pos)
	goalCol = null
}

// ── Key handling ──
// Returns true if the key was handled.

export function handleKey(data: string, contentWidth: number): boolean {
	// Alt-Enter: insert newline
	if (data === '\x1b\r' || data === '\x1b\n') { insertAt('\n'); return true }

	// Backspace
	if (data === '\x7f' || data === '\x08') {
		if (cursor > 0) deleteRange(cursor - 1, cursor)
		return true
	}

	// Ctrl-D: delete forward
	if (data === '\x04') {
		if (cursor < buf.length) deleteRange(cursor, cursor + 1)
		return true
	}

	// Ctrl-A / Ctrl-E: home / end
	if (data === '\x01') { move(0); return true }
	if (data === '\x05') { move(buf.length); return true }

	// Ctrl-K: kill to end
	if (data === '\x0b') { buf = buf.slice(0, cursor); goalCol = null; return true }

	// Ctrl-W: delete word back
	if (data === '\x17') {
		if (cursor > 0) deleteRange(wordBoundaryLeft(buf, cursor), cursor)
		return true
	}

	// Arrow left / right
	if (data === '\x1b[D') { move(cursor - 1); return true }
	if (data === '\x1b[C') { move(cursor + 1); return true }

	// Alt-Left / Alt-Right: word boundaries
	if (data === '\x1b[1;3D' || data === '\x1bb') { move(wordBoundaryLeft(buf, cursor)); return true }
	if (data === '\x1b[1;3C' || data === '\x1bf') { move(wordBoundaryRight(buf, cursor)); return true }

	// Up / Down: vertical movement in wrapped input
	if (data === '\x1b[A' || data === '\x1b[B') {
		const dir = data === '\x1b[A' ? -1 : 1
		const r = verticalMove(buf, contentWidth, cursor, goalCol, dir)
		if (!r.atBoundary) {
			cursor = r.cursor
			goalCol = r.goalCol
		}
		return true
	}

	// Printable characters
	if (data >= ' ' && !data.startsWith('\x1b')) { insertAt(data); return true }

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

	// Prompt lines with 1-char padding
	const lines: string[] = []
	for (let i = scrollTop; i < scrollTop + promptLines; i++) {
		lines.push(` ${layout.lines[i] ?? ''}`)
	}

	return {
		separator: sep,
		lines,
		cursor: { rowOffset: curRow - scrollTop, col: curCol + 2 },
	}
}

/** Number of visible prompt lines for current input. */
export function lineCount(contentWidth: number): number {
	return Math.min(getWrappedInputLayout(buf, contentWidth).lines.length, MAX_PROMPT_LINES)
}
