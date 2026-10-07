// High-water marks: streaming blocks and call cards never shrink until
// the next full redraw. The marks live in frame.state.peaks. Tasks: fn.
import type { Item } from '../common/transcript.ts'
import type { Style } from '../common/colors.ts'
import { ansi } from './ansi.ts'
import { itemView } from './item-view.ts'

// A streaming block never shrinks (task fn): the tallest it was drawn
// at, from its first render here, pads it with blank rows at its end,
// also after it stops streaming, until the next full redraw (render.draw
// forgets them all). In memory only, per block and width.
function high(peaks: Map<string, number>, rows: string[], item: Item, cols: number, session: string | undefined, streams: boolean): string[] {
	let id = `${cols} ${session} ${item.key}`
	let peak = peaks.get(id)
	if (peak === undefined && !streams) return rows
	if (rows.length >= (peak ?? 0)) {
		peaks.set(id, rows.length)
		return rows
	}
	return [...rows, ...Array<string>(peak! - rows.length).fill(ansi.paint('', itemView.itemStyle(item), cols))]
}

// A call's card, with its results, never shrinks either: a running
// call's last output lines give way to a shorter result glimpse, and in
// full mode one row less clears scrollback, snapping the terminal to the
// bottom. Blank card rows at its end keep the tallest height drawn at
// this width and fold state until the next full redraw; folding with
// /collapse starts afresh.
function card(peaks: Map<string, number>, lines: string[], start: number, id: string, style: Style | undefined, cols: number): void {
	let height = lines.length - start, peak = peaks.get(id) ?? 0
	if (height >= peak) peaks.set(id, height)
	else for (let n = height; n < peak; n++) lines.push(ansi.paint('', style, cols))
}

export const water = { high, card }
