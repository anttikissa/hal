// Prompt area: state, key handling, and line building.

import type { CursorPos } from './cli-render.ts'
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

function collapseSelectionOrMove(pos: number, edge: 'start' | 'end'): void {
	const sel = selRange()
	if (sel) {
		cursor = edge === 'start' ? sel.start : sel.end
		selAnchor = null
		goalCol = null
	} else {
		move(pos, false)
	}
}

// ── Cmd key (Kitty keyboard protocol) ──

/** Parse CSI u key. Returns cmd char if super modifier held, null otherwise. */
function parseCmdKey(data: string): string | null {
	// CSI u format: \x1b[codepoint;modifier[;text]u
	if (!data.startsWith('\x1b[') || !data.endsWith('u')) return null
	const body = data.slice(2, -1)
	const fields = body.split(';')
	const codepoint = Number((fields[0] || '').split(':', 1)[0])
	const modPart = fields[1] ?? ''
	const [rawModStr, eventTypeStr] = modPart.split(':', 2)
	const modifier = Number(rawModStr || '1')
	const eventType = Number(eventTypeStr || '1')
	if (!Number.isFinite(codepoint) || !Number.isFinite(modifier)) return null
	if (eventType !== 1) return null // ignore key-up events
	if (modifier < 9) return null // super (Cmd) = modifier bit 8 → raw ≥ 9
	return String.fromCharCode(codepoint).toLowerCase()
}

function writeClipboard(text: string): void {
	if (!text) return
	try { const p = Bun.spawn(['pbcopy'], { stdin: 'pipe' }); p.stdin.write(text); p.stdin.end() } catch {}
}

function readClipboard(): string {
	try { return Bun.spawnSync(['pbpaste']).stdout.toString() } catch { return '' }
}

// ── Key handling ──
// Returns true if the key was handled.

export function handleKey(data: string, contentWidth: number): boolean {
	// Cmd+key (Kitty keyboard protocol)
	const cmdKey = parseCmdKey(data)
	if (cmdKey) {
		if (cmdKey === 'c') {
			const sel = selRange()
			if (sel) writeClipboard(buf.slice(sel.start, sel.end))
			return true
		}
		if (cmdKey === 'x') {
			const sel = selRange()
			if (sel) { writeClipboard(buf.slice(sel.start, sel.end)); deleteRange(sel.start, sel.end) }
			return true
		}
		if (cmdKey === 'v') {
			const text = readClipboard().replace(/\r\n/g, '\n').replace(/\r/g, '\n')
			if (text) replaceSelection(text)
			return true
		}
		if (cmdKey === 'a') {
			selAnchor = 0; cursor = buf.length
			return true
		}
		return false
	}

	// Alt-Enter: insert newline
	if (data === '\x1b\r' || data === '\x1b\n') { replaceSelection('\n'); return true }

	// Backspace
	if (data === '\x7f' || data === '\x08') {
		const sel = selRange()
		if (sel) deleteRange(sel.start, sel.end)
		else if (cursor > 0) deleteRange(cursor - 1, cursor)
		return true
	}

	// Ctrl-D: delete forward
	if (data === '\x04') {
		const sel = selRange()
		if (sel) deleteRange(sel.start, sel.end)
		else if (cursor < buf.length) deleteRange(cursor, cursor + 1)
		return true
	}

	// Ctrl-A: select all
	if (data === '\x01') { selAnchor = 0; cursor = buf.length; return true }

	// Ctrl-E: end of line
	if (data === '\x05') { move(buf.length, false); return true }

	// Ctrl-K: kill to end
	if (data === '\x0b') {
		const sel = selRange()
		if (sel) deleteRange(sel.start, sel.end)
		else { buf = buf.slice(0, cursor); goalCol = null; selAnchor = null }
		return true
	}

	// Ctrl-W: delete word back
	if (data === '\x17') {
		const sel = selRange()
		if (sel) deleteRange(sel.start, sel.end)
		else if (cursor > 0) deleteRange(wordBoundaryLeft(buf, cursor), cursor)
		return true
	}

	// Arrow left / right
	if (data === '\x1b[D') { collapseSelectionOrMove(cursor - 1, 'start'); return true }
	if (data === '\x1b[C') { collapseSelectionOrMove(cursor + 1, 'end'); return true }

	// Shift+Arrow left / right
	if (data === '\x1b[1;2D') { move(cursor - 1, true); return true }
	if (data === '\x1b[1;2C') { move(cursor + 1, true); return true }

	// Alt-Left / Alt-Right: word boundaries
	if (data === '\x1b[1;3D' || data === '\x1bb') { move(wordBoundaryLeft(buf, cursor), false); return true }
	if (data === '\x1b[1;3C' || data === '\x1bf') { move(wordBoundaryRight(buf, cursor), false); return true }

	// Shift+Alt-Left / Shift+Alt-Right: word select
	if (data === '\x1b[1;4D') { move(wordBoundaryLeft(buf, cursor), true); return true }
	if (data === '\x1b[1;4C') { move(wordBoundaryRight(buf, cursor), true); return true }

	// Up / Down
	if (data === '\x1b[A' || data === '\x1b[B') {
		selAnchor = null
		const dir = data === '\x1b[A' ? -1 : 1
		const r = verticalMove(buf, contentWidth, cursor, goalCol, dir)
		if (!r.atBoundary) { cursor = r.cursor; goalCol = r.goalCol }
		return true
	}

	// Shift+Up / Shift+Down
	if (data === '\x1b[1;2A' || data === '\x1b[1;2B') {
		if (selAnchor === null) selAnchor = cursor
		const dir = data === '\x1b[1;2A' ? -1 : 1
		const r = verticalMove(buf, contentWidth, cursor, goalCol, dir)
		if (!r.atBoundary) { cursor = r.cursor; goalCol = r.goalCol }
		return true
	}

	// Printable characters: replace selection
	if (data >= ' ' && !data.startsWith('\x1b')) { replaceSelection(data); return true }

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
