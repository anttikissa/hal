// How prompt text lays out in rows: the one layout the terminal draws
// and Up/Down move through, so the two can never disagree. Rows come
// from strings.wordWrap (breaks after spaces, else mid-word; a space at
// a break is dropped) and are kept as source offset ranges.
//
// Columns are display columns: wide glyphs take two, a tab reaches the
// next 4-column stop counted from its row's start. A cursor on a dropped
// space, or after a row that exactly fills the width, sits just past
// the row's text: in the right padding, never wrapped early.

import { strings } from './strings.ts'

/** A row of text: source offsets [start, end). */
export type Row = { start: number; end: number }

/** The box: its first visible row, height, and rows hidden around it. */
export type Viewport = { top: number; height: number; above: number; below: number }

// Rows of `text` wrapped to `width` columns. Always at least one row.
function rows(text: string, width: number): Row[] {
	text = strings.clean(text)
	let out: Row[] = []
	let pos = 0
	for (let line of text.split('\n')) {
		let end = pos + line.length
		let at = pos
		for (let r of strings.wordWrap(line, width)) {
			// wordWrap returns slices of the line; skip a dropped space.
			if (!text.startsWith(r, at)) at++
			out.push({ start: at, end: at + r.length })
			at += r.length
		}
		// A dropped space at the very end leaves the cursor a row of its own.
		if (at < end) out.push({ start: end, end })
		pos = end + 1
	}
	return out
}

// The row and column where the cursor offset shows.
function position(text: string, list: Row[], cursor: number): { row: number; col: number } {
	let row = list.length - 1
	for (let i = 0; i < list.length - 1; i++) {
		if (cursor < list[i + 1]!.start) {
			row = i
			break
		}
	}
	let r = list[row]!
	return { row, col: strings.visLen(strings.clean(text).slice(r.start, Math.min(cursor, r.end))) }
}

// The offset nearest to column `col` on row `row`. A column inside a
// wide glyph or tab snaps to its nearer edge. A row broken mid-word
// ends before its last glyph: its end offset shows on the next row.
function offsetAt(text: string, list: Row[], row: number, col: number): number {
	text = strings.clean(text)
	let r = list[row]!
	let next = list[row + 1]
	let last = next && next.start === r.end ? r.end - 1 : r.end
	let vis = 0
	let i = r.start
	while (i < r.end) {
		let g = strings.glyphAt(text, i, vis)
		if (i + g.length > last) break
		if (vis + g.width > col) return col - vis < g.width / 2 ? i : i + g.length
		vis += g.width
		i += g.length
	}
	return i
}

// Rows the box shows by itself: all of them, up to `max`.
function autoHeight(total: number, max: number): number {
	return Math.max(1, Math.min(total, max))
}

// The box's rows: `height` of `total`, starting at `top` if the cursor
// row stays in view there, else moved just enough to show it with one
// row of context (when the box has room for it).
function viewport(top: number, height: number, total: number, row: number): Viewport {
	let max = Math.max(0, total - height)
	let context = height >= 3 ? 1 : 0
	top = Math.max(0, Math.min(top, max))
	if (row < top) top = Math.max(0, row - context)
	if (row >= top + height) top = Math.min(max, row - height + context + 1)
	return { top, height, above: top, below: Math.max(0, total - top - height) }
}

export const promptLayout = { rows, position, offsetAt, autoHeight, viewport }
