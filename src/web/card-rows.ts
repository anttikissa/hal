/// <reference lib="dom" />
// How many rows a card's text takes, wrapped like a terminal in the
// monospace columns its header measures (Card.tsx: peek counts, tall
// cards).

import { bashResult } from '../common/bash-result.ts'
import type { Item } from '../common/transcript.ts'

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

export const cardRows = { rows, outputLines, columns }
