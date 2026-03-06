// Pure diff renderer for terminal output.
// No state, no side effects. Takes old/new lines → escape sequence.
// Diff rendering approach inspired by pi-mono (https://github.com/badlogic/pi-mono).

import { appendFileSync } from 'fs'

const LOG = '/tmp/hal-cli-debug.log'
function trace(msg: string): void {
	appendFileSync(LOG, `${Date.now()} ${msg}\n`)
}

export interface RenderState {
	lines: string[]
	cursorRow: number
}

export interface CursorPos {
	row: number
	col: number
}

export const emptyState: RenderState = { lines: [], cursorRow: 0 }

// Synchronized output: terminal buffers everything between these, avoids flicker
const SYNC_START = '\x1b[?2026h'
const SYNC_END = '\x1b[?2026l'

/** Diff-render newLines against prev. Returns escape buf + new state. */
export function render(
	newLines: string[],
	prev: RenderState,
	cursor: CursorPos,
	screenRows: number,
): { buf: string; state: RenderState } {
	trace(`render: prev=${prev.lines.length} new=${newLines.length} cursorRow=${prev.cursorRow} screen=${screenRows}`)
	// First render: write everything inline from current position
	if (prev.lines.length === 0) {
		trace('  → fullRender (first)')
		return fullRender(newLines, cursor, false)
	}

	// Find changed range
	let firstChanged = -1
	let lastChanged = -1
	const maxLen = Math.max(newLines.length, prev.lines.length)
	for (let i = 0; i < maxLen; i++) {
		if ((newLines[i] ?? '') !== (prev.lines[i] ?? '')) {
			if (firstChanged === -1) firstChanged = i
			lastChanged = i
		}
	}

	// Nothing changed
	if (firstChanged === -1) { trace('  → no changes'); return { buf: '', state: prev } }

	// Changes above visible viewport — can't reach with relative moves
	const viewportTop = Math.max(0, prev.lines.length - screenRows)
	trace(`  changed=${firstChanged}..${lastChanged} viewportTop=${viewportTop}`)
	if (firstChanged < viewportTop) {
		if (lastChanged < viewportTop) {
			trace('  → skip (all changes above viewport)')
			return { buf: '', state: prev }
		}
		trace('  → fullRender (changes span viewport boundary)')
		return fullRender(newLines, cursor, true)
	}

	let buf = SYNC_START

	// Optimize pure appends: move to last old line, then \r\n into new territory
	const isAppend = newLines.length > prev.lines.length
		&& firstChanged === prev.lines.length
		&& firstChanged > 0
	const moveTarget = isAppend ? firstChanged - 1 : firstChanged
	trace(`  diff: isAppend=${isAppend} moveTarget=${moveTarget} cursorRow=${prev.cursorRow}`)
	buf += moveCursor(prev.cursorRow, moveTarget)
	buf += isAppend ? '\r\n' : '\r'

	// Write changed lines
	const renderEnd = Math.min(lastChanged, newLines.length - 1)
	for (let i = firstChanged; i <= renderEnd; i++) {
		if (i > firstChanged) buf += '\r\n'
		buf += `\x1b[2K${newLines[i]}`
	}

	let cursorRow = renderEnd

	// Clear leftover lines if content shrunk
	if (prev.lines.length > newLines.length) {
		const extra = prev.lines.length - newLines.length
		trace(`  shrink: clearing ${extra} lines`)
		if (renderEnd < newLines.length - 1) {
			buf += moveCursor(cursorRow, newLines.length - 1)
			cursorRow = newLines.length - 1
		}
		for (let i = 0; i < extra; i++) buf += '\r\n\x1b[2K'
		buf += `\x1b[${extra}A`
	}

	buf += positionCursor(cursorRow, cursor)
	buf += SYNC_END

	return { buf, state: { lines: newLines, cursorRow: cursor.row } }
}

function fullRender(
	lines: string[],
	cursor: CursorPos,
	clear: boolean,
): { buf: string; state: RenderState } {
	let buf = SYNC_START
	if (clear) buf += '\x1b[3J\x1b[2J\x1b[H'
	for (let i = 0; i < lines.length; i++) {
		if (i > 0) buf += '\r\n'
		buf += lines[i]
	}
	buf += positionCursor(lines.length - 1, cursor)
	buf += SYNC_END
	return { buf, state: { lines, cursorRow: cursor.row } }
}

function moveCursor(from: number, to: number): string {
	const delta = to - from
	if (delta > 0) return `\x1b[${delta}B`
	if (delta < 0) return `\x1b[${-delta}A`
	return ''
}

function positionCursor(currentRow: number, target: CursorPos): string {
	return moveCursor(currentRow, target.row) + `\x1b[${target.col}G\x1b[?25h`
}
