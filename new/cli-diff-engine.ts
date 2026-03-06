// Line-level diff engine for terminal output.
// Takes old/new lines → minimal ANSI escape sequence.

import { appendFileSync, writeFileSync } from 'fs'

export interface RenderState {
	lines: string[]
	cursorRow: number
	cursorCol: number
}

export interface CursorPos {
	row: number
	col: number
}

export const emptyState: RenderState = { lines: [], cursorRow: 0, cursorCol: 0 }

// Synchronized output: terminal buffers everything between these, avoids flicker
const SYNC_START = '\x1b[?2026h'
const SYNC_END = '\x1b[?2026l'


// ── Debug log ──

const LOG_PATH = '/tmp/cli-raw.log'
let logEnabled = false

export function enableLog(): void {
	logEnabled = true
	writeFileSync(LOG_PATH, '')
}

function log(msg: string): void {
	if (!logEnabled) return
	appendFileSync(LOG_PATH, msg.replace(/\x1b/g, '\\e').replace(/\r/g, '\\r').replace(/\n/g, '\\n') + '\n')
}

// ── Intra-line patching ──

function patchLine(old: string, nw: string): string | null {
	let i = 0, vis = 0, sgrState = '', esc = 0, escStart = 0
	while (i < old.length && i < nw.length && old[i] === nw[i]) {
		if (esc === 0) {
			if (old[i] === '\x1b') { esc = 1; escStart = i } else vis++
		} else if (esc === 1) {
			esc = old[i] === '[' ? 2 : 0
		} else if (old.charCodeAt(i) >= 0x40 && old.charCodeAt(i) <= 0x7e) {
			if (old[i] === 'm') {
				const seq = old.slice(escStart, i + 1)
				if (seq === '\x1b[0m' || seq === '\x1b[m') sgrState = ''
				else sgrState += seq
			}
			esc = 0
		}
		i++
	}
	if (i >= old.length && i >= nw.length) return null
	if (esc !== 0 || i < 6) return null
	const col = `\x1b[${vis + 1}G${sgrState}`
	if (old.length === nw.length) {
		let j = old.length - 1
		while (j > i && old[j] === nw[j]) j--
		if (nw.slice(i, j + 1).includes('\x1b'))
			return `${col}${nw.slice(i)}\x1b[K`
		return `${col}${nw.slice(i, j + 1)}${sgrState ? '\x1b[0m' : ''}`
	}
	return `${col}${nw.slice(i)}\x1b[K`
}

// ── Diff renderer ──

/** Diff-render newLines against prev. Returns escape buf + new state. */
export function render(
	newLines: string[],
	prev: RenderState,
	cursor: CursorPos,
	screenRows: number,
): { buf: string; state: RenderState } {
	if (prev.lines.length === 0) {
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

	if (firstChanged === -1) {
		if (cursor.row === prev.cursorRow && cursor.col === prev.cursorCol) return { buf: '', state: prev }
		const buf = SYNC_START + positionCursor(prev.cursorRow, cursor) + SYNC_END
		return { buf, state: { lines: prev.lines, cursorRow: cursor.row, cursorCol: cursor.col } }
	}

	// Changes above visible viewport — can't reach with relative moves
	const viewportTop = Math.max(0, prev.lines.length - screenRows)
	if (firstChanged < viewportTop) {
		if (lastChanged < viewportTop) return { buf: '', state: prev }
		return fullRender(newLines, cursor, true)
	}

	let buf = SYNC_START

	// Optimize pure appends: move to last old line, then \r\n into new territory
	const isAppend = newLines.length > prev.lines.length
		&& firstChanged === prev.lines.length
		&& firstChanged > 0
	const moveTarget = isAppend ? firstChanged - 1 : firstChanged
	buf += moveCursor(prev.cursorRow, moveTarget)
	buf += isAppend ? '\r\n' : '\r'

	// Write changed lines
	const renderEnd = Math.min(lastChanged, newLines.length - 1)
	for (let i = firstChanged; i <= renderEnd; i++) {
		if (i > firstChanged) buf += '\r\n'
		const patch = patchLine(prev.lines[i] ?? '', newLines[i])
		const lineCmd = patch ?? `\x1b[2K${newLines[i]}`
		log(`${patch ? 'patc' : 'full'}:${i} (${lineCmd.length}b)  ${lineCmd}`)
		buf += lineCmd
	}

	let cursorRow = renderEnd

	// Clear leftover lines if content shrunk
	if (prev.lines.length > newLines.length) {
		const extra = prev.lines.length - newLines.length
		if (renderEnd < newLines.length - 1) {
			buf += moveCursor(cursorRow, newLines.length - 1)
			cursorRow = newLines.length - 1
		}
		for (let i = 0; i < extra; i++) buf += '\r\n\x1b[2K'
		buf += `\x1b[${extra}A`
	}

	buf += positionCursor(cursorRow, cursor)
	buf += SYNC_END

	return { buf, state: { lines: newLines, cursorRow: cursor.row, cursorCol: cursor.col } }
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
	return { buf, state: { lines, cursorRow: cursor.row, cursorCol: cursor.col } }
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
