// The frame: every row the terminal should show, from the first
// transcript item to the prompt, and where the cursor goes. Pure; the
// renderer (render.ts) decides how to get it onto the terminal.
//
// All history is always in the frame, never a viewport-sized slice
// (tasks/cc/terminal.md rule 3). Every row fits the terminal width, has
// its tabs expanded, and carries no control characters from the text
// it shows.

import { strings } from '../common/strings.ts'
import type { Item, Transcript } from '../common/transcript.ts'
import type { PromptState } from './prompt.ts'

export interface View {
	transcript?: Transcript
	prompt: PromptState
	/** A passing message for the user, such as a refused command. */
	notice?: string
}

export interface Frame {
	lines: string[]
	/** Where the terminal cursor belongs; row into lines, 0-based column. */
	cursor: { row: number; col: number }
}

// One blank column on each side of every row.
const PAD = ' '
const PROMPT_FIRST = '> '
const PROMPT_REST = '  '
const DIM = '\x1b[2m'
const UNDIM = '\x1b[22m'

// Text from the model, tools or a paste must not drive the terminal:
// control characters other than newline and tab become visible. Keeps
// offsets, so a prompt cursor still points at the same place.
function clean(s: string): string {
	return s.replace(/(?![\n\t])\p{Cc}/gu, '\ufffd')
}

function wrap(text: string, width: number): string[] {
	return strings.wordWrap(strings.expandTabs(frame.clean(text.replace(/\r\n?/g, '\n'))), width)
}

// Rows for one item at `width` columns, without the side padding.
function itemLines(item: Item, width: number): string[] {
	switch (item.type) {
		case 'prompt':
			return frame.wrap(item.text, width - PROMPT_FIRST.length).map((l, i) => (i ? PROMPT_REST : PROMPT_FIRST) + l)
		case 'text':
			return frame.wrap(item.text, width)
		case 'thinking':
			return frame.wrap(item.text, width).map((l) => DIM + l + UNDIM)
		case 'tool': {
			let input = frame.clean(JSON.stringify(item.input)).replace(/\s+/g, ' ')
			return [strings.clipVisual(`▸ ${frame.clean(item.name)} ${input}`, width)]
		}
		case 'turn-end':
			if (item.status === 'error') return frame.wrap(`error: ${item.error ?? 'turn failed'}`, width)
			if (item.status === 'completed') return []
			return [`[${item.status}]`]
	}
}

/**
 * Lay out prompt text in rows of `width` columns, hard-wrapped, and find
 * the row and column of the cursor offset. A cursor after a full row
 * sits in the column just past it, which is the right padding.
 */
function layoutPrompt(text: string, cursor: number, width: number): { rows: string[]; row: number; col: number } {
	text = frame.clean(text)
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

function build(view: View, cols: number): Frame {
	let width = Math.max(1, cols - 2 * PAD.length)
	let lines: string[] = []
	for (let item of view.transcript?.items ?? []) {
		let rows = frame.itemLines(item, width)
		if (!rows.length) continue
		if (lines.length) lines.push('')
		for (let r of rows) lines.push(PAD + r)
	}
	if (view.notice) {
		if (lines.length) lines.push('')
		for (let r of frame.wrap(view.notice, width)) lines.push(PAD + DIM + r + UNDIM)
	}
	if (lines.length) lines.push('')
	let promptWidth = Math.max(1, width - PROMPT_FIRST.length)
	let p = frame.layoutPrompt(view.prompt.text, view.prompt.cursor, promptWidth)
	let top = lines.length
	p.rows.forEach((r, i) => lines.push(PAD + (i ? PROMPT_REST : PROMPT_FIRST) + r))
	return { lines, cursor: { row: top + p.row, col: PAD.length + PROMPT_FIRST.length + p.col } }
}

export const frame = { clean, wrap, itemLines, layoutPrompt, build }
