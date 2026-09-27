// The prompt as the frame shows it: its markers and how its text lays
// out in rows with the cursor among them. Pure.

import { ansi } from './ansi.ts'
import { strings } from '../common/strings.ts'

/**
 * Lay out prompt text in rows of `width` columns, hard-wrapped, and find
 * the row and column of the cursor offset. A cursor after a full row
 * sits in the column just past it, which is the right padding.
 */
function layoutPrompt(text: string, cursor: number, width: number): { rows: string[]; row: number; col: number } {
	text = ansi.clean(text)
	let rows: string[] = []
	let row = ''
	let col = 0
	let at: { row: number; col: number } | undefined
	let i = 0
	while (i < text.length) {
		if (text[i] === '\n') {
			if (!at && i >= cursor) at = { row: rows.length, col }
			rows.push(row)
			row = ''
			col = 0
			i++
			continue
		}
		let g = strings.glyphAt(text, i, col)
		if (col + g.width > width && col > 0) {
			rows.push(row)
			row = ''
			col = 0
			g = strings.glyphAt(text, i, col)
		}
		// A tab never reaches past the row.
		if (text[i] === '\t') g = { width: Math.max(1, Math.min(g.width, width - col)), length: 1 }
		if (!at && i >= cursor) at = { row: rows.length, col }
		row += text[i] === '\t' ? ' '.repeat(g.width) : text.slice(i, i + g.length)
		col += g.width
		i += g.length
	}
	at ??= { row: rows.length, col }
	rows.push(row)
	return { rows, ...at }
}

// Text rows marked as a prompt: the first with `FIRST`, the rest indented.
function mark(rows: string[]): string[] {
	return rows.map((l, i) => (i ? promptView.REST : promptView.FIRST) + l)
}

export const promptView = {
	FIRST: '> ',
	REST: '  ',
	layoutPrompt,
	mark,
}
