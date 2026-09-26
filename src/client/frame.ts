// The frame: every row the terminal should show, from the first
// transcript item to the prompt, and where the cursor goes. Pure; the
// renderer (render.ts) decides how to get it onto the terminal.
//
// All history is always in the frame, never a viewport-sized slice
// (tasks/cc/terminal.md rule 3). Every row fits the terminal width, has
// its tabs expanded, and carries no control characters from the text
// it shows.

import { colors, type Style } from '../common/colors.ts'
import { oklch } from '../common/oklch.ts'
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
const UNCOLOR = '\x1b[39;49m'

// The escape that switches to a style's fg and bg (truecolor).
function sgr(style: Style): string {
	let parts: string[] = []
	if (style.fg) parts.push(`38;2;${oklch.toRgb(style.fg).join(';')}`)
	if (style.bg) parts.push(`48;2;${oklch.toRgb(style.bg).join(';')}`)
	return parts.length ? `\x1b[${parts.join(';')}m` : ''
}

// A padded row in a style. With a background it is a card filling all
// `cols` columns; colour always ends with the row.
function paint(row: string, style: Style | undefined, cols: number): string {
	let on = style ? frame.sgr(style) : ''
	if (!on) return PAD + row
	let fill = style!.bg ? ' '.repeat(Math.max(0, cols - PAD.length - strings.visLen(row))) : ''
	return on + PAD + row + fill + UNCOLOR
}

// The style of a tool's name: toolBash for bash, tool for one without its own.
function toolStyle(name: string): Style {
	let key = 'tool' + name.charAt(0).toUpperCase() + name.slice(1)
	let style = (colors as Record<string, unknown>)[key]
	return typeof style === 'function' ? style() : colors.tool()
}

function itemStyle(item: Item): Style | undefined {
	switch (item.type) {
		case 'prompt':
			return colors.user()
		case 'text':
			return { fg: colors.assistant().fg! }
		case 'thinking':
			return { fg: colors.thinking().fg! }
		case 'tool':
			return frame.toolStyle(item.name)
		case 'tool-result':
			return { fg: (item.isError ? colors.error() : colors.log()).fg! }
		case 'turn-end':
			return item.status === 'error' ? colors.error() : { fg: colors.log().fg! }
	}
}

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
			return frame.wrap(item.text, width)
		case 'tool': {
			let { command, description } = item.input
			// A described command: the sentence first, the command dimmed beside it.
			if (typeof command === 'string' && typeof description === 'string') {
				let head = strings.clipVisual(`▸ ${frame.clean(description).replace(/\s+/g, ' ')}`, width)
				let rest = strings.clipVisual(`  $ ${frame.clean(command).replace(/\s+/g, ' ')}`, width - strings.visLen(head))
				return [head + (rest ? DIM + rest + UNDIM : '')]
			}
			let input = frame.clean(JSON.stringify(item.input)).replace(/\s+/g, ' ')
			return [strings.clipVisual(`▸ ${frame.clean(item.name)} ${input}`, width)]
		}
		case 'tool-result': {
			// A glimpse: tool output can be long, the model sees all of it.
			let rows = frame.wrap(item.output.replace(/\n$/, ''), Math.max(1, width - 2))
			let shown = rows.slice(0, frame.resultRows())
			if (rows.length > shown.length) shown.push(`… ${rows.length - shown.length} more lines`)
			return shown.map((l, i) => DIM + strings.clipVisual((i ? '  ' : item.isError ? '✗ ' : '◂ ') + l, width) + UNDIM)
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
		let style = frame.itemStyle(item)
		for (let r of rows) lines.push(frame.paint(r, style, cols))
	}
	if (view.notice) {
		if (lines.length) lines.push('')
		for (let r of frame.wrap(view.notice, width)) lines.push(frame.paint(r, { fg: colors.log().fg! }, cols))
	}
	if (lines.length) lines.push('')
	let promptWidth = Math.max(1, width - PROMPT_FIRST.length)
	let p = frame.layoutPrompt(view.prompt.text, view.prompt.cursor, promptWidth)
	let top = lines.length
	let input = colors.input()
	p.rows.forEach((r, i) => lines.push(frame.paint((i ? PROMPT_REST : PROMPT_FIRST) + r, input, cols)))
	return { lines, cursor: { row: top + p.row, col: PAD.length + PROMPT_FIRST.length + p.col } }
}

export const frame = {
	// Rows of a tool result shown in the transcript.
	resultRows: () => 3,
	clean,
	wrap,
	sgr,
	paint,
	toolStyle,
	itemStyle,
	itemLines,
	layoutPrompt,
	build,
}
