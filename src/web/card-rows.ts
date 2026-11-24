/// <reference lib="dom" />
// How many rows a card's text takes, wrapped like a terminal in the
// monospace columns its header measures (Card.tsx: peek counts, tall
// cards).

import { bashResult } from '../common/bash-result.ts'
import { card } from '../common/card.ts'
import { forms } from '../common/forms.ts'
import type { Item } from '../common/transcript.ts'
import type { Row } from './transcript-rows.ts'

// Rows `text` wraps to in `cols` monospace columns, as in a terminal.
function rows(text: string, cols: number): number {
	return text.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / cols)), 0)
}

// Lines of a tool's output (its shown result, else what has streamed)
// or of a background Bash result; undefined for other items.
function outputLines(item: Item, result: string | undefined): number | undefined {
	let output =
		item.type === 'tool'
			? (result ?? item.partial ?? '')
			: bashResult.background(item) && item.type === 'prompt'
				? bashResult.display(item.text)
				: undefined
	return output === undefined ? undefined : output ? output.replace(/\n$/, '').split('\n').length : 0
}

// Estimated pixel height of a transcript row (card + 0.5lh bottom
// margin), used to size the space above unmounted rows without
// mounting their DOM (task tzg).
function height(row: Row, open: boolean, cols: number, lh: number): number {
	let item = row.item
	let oneRow =
		['turn-end', 'divider'].includes(item.type) ||
		(item.type === 'command' && item.from === undefined && item.output === undefined)
	// Collapsed and one-row cards are always one line: header (44+lh)/2 + 0.5lh margin.
	if (!open || oneRow) return 22 + lh
	let chrome = 33 + lh
	if (item.type === 'image') return chrome + 15 * lh
	if (item.type === 'question')
		return chrome + (cardRows.rows(forms.title(item.form), cols) + item.form.fields.length * 3) * lh
	let text =
		item.type === 'tool'
			? `${typeof item.input.command === 'string' ? `${item.input.command}\n` : ''}${row.result?.output ?? item.partial ?? ''}`
			: item.type === 'prompt' || item.type === 'text' || item.type === 'thinking'
				? card.text(item)
				: item.type === 'output'
					? item.text
					: item.type === 'command'
						? (item.output ?? item.text)
						: ''
	text = text.replace(/\n$/, '')
	return chrome + (text ? cardRows.rows(text, cols) : 1) * lh
}

// Total estimated pixels for `rows[from..to)`.
function span(rows: readonly Row[], from: number, to: number, heightOf: (row: Row) => number): number {
	let sum = 0
	for (let i = from; i < to; i++) sum += heightOf(rows[i]!)
	return Math.round(sum)
}

// Space above `start` mounted rows, including `unfetched` earlier rows
// estimated from the earliest loaded rows rather than the newest window.
function space(rows: readonly Row[], start: number, unfetched: number, heightOf: (row: Row) => number): number {
	let sum = 0
	for (let i = 0; i < start; i++) sum += heightOf(rows[i]!)
	if (unfetched > 0 && rows.length) {
		let sample = Math.min(rows.length, 100),
			samplePx = 0
		for (let i = 0; i < sample; i++) samplePx += heightOf(rows[i]!)
		sum += unfetched * (samplePx / sample)
	}
	return Math.round(sum)
}

// Row index estimated at scroll coordinate `center` (< `pad`) above `start`,
// or -1 when `center` lies above all loaded rows.
function locate(
	rows: readonly Row[],
	start: number,
	pad: number,
	center: number,
	heightOf: (row: Row) => number,
): number {
	let y = pad
	for (let i = start - 1; i >= 0; i--) {
		y -= heightOf(rows[i]!)
		if (y <= center) return i
	}
	return -1
}

let canvas: CanvasRenderingContext2D | null | undefined

// Body columns: the header's inner width over the font's character width.
function columns(header: HTMLElement): number {
	let style = getComputedStyle(header)
	canvas ??= document.createElement('canvas').getContext('2d')
	canvas!.font = style.font
	return Math.max(
		1,
		Math.floor(
			(header.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)) /
				canvas!.measureText('0').width,
		),
	)
}

export const cardRows = { rows, outputLines, height, span, space, locate, columns }
