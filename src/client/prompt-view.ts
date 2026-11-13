// The prompt as the frame shows it: its markers, how its text lays out
// in rows with the cursor among them, and the scrolling box around
// them. Pure.

import { ansi } from './ansi.ts'
import type { Oklch } from '../common/oklch.ts'
import { placeholders, type Shown } from '../common/placeholders.ts'
import { promptLayout } from '../common/prompt-layout.ts'
import { prompt, type PromptState } from '../common/prompt.ts'
import { settings } from '../common/settings.ts'
import { strings } from '../common/strings.ts'

/**
 * Lay out prompt text in rows of `width` columns, as Up/Down see it
 * (common/prompt-layout.ts), tabs drawn as spaces, and find the row and
 * column of the cursor offset. The selection `sel` shows in reverse
 * video; a selected tab is reverse spaces to its stop.
 */
function layoutPrompt(
	text: string,
	cursor: number,
	width: number,
	sel?: { start: number; end: number },
): { rows: string[]; row: number; col: number } {
	let list = promptLayout.rows(text, width)
	let clean = ansi.clean(text)
	// A tab or wide glyph alone on a row narrower than itself is cut.
	let rows = list.map((r) => {
		let raw = clean.slice(r.start, r.end)
		let row = strings.sliceVisual(strings.expandTabs(raw), 0, width)
		let lo = sel ? Math.max(sel.start, r.start) - r.start : 0
		let hi = sel ? Math.min(sel.end, r.end) - r.start : 0
		if (lo >= hi) return ansi.links(row)
		// Tab stops count from the row's start, so expanded prefixes line up.
		let [a, b] = [lo, hi].map((i) => Math.min(row.length, strings.expandTabs(raw.slice(0, i)).length))
		return row.slice(0, a) + ansi.INVERSE + row.slice(a, b) + ansi.UNINVERSE + row.slice(b)
	})
	let at = promptLayout.position(text, list, cursor)
	return { rows, row: at.row, col: Math.min(at.col, width) }
}

// A full-width rule `cols` wide: `left` at its left end, `right` at its
// right end and `center` in the middle (pushed aside when they would
// meet), clipped to fit: center first kept, then left, then right.
// Unpainted.
function rule(cols: number, left = '', center = '', right = ''): string {
	let pad = (s: string) => (s ? ` ${s} ` : '')
	let c = strings.clipVisual(pad(center), cols)
	let cw = strings.visLen(c)
	let l = strings.clipVisual(pad(left), Math.max(0, cols - cw))
	let lw = strings.visLen(l)
	let r = strings.clipVisual(pad(right), Math.max(0, cols - cw - lw))
	let rw = strings.visLen(r)
	let at = Math.max(lw, Math.min(Math.floor((cols - cw) / 2), cols - cw - rw))
	return l + '─'.repeat(at - lw) + c + '─'.repeat(Math.max(0, cols - at - cw - rw)) + r
}

// What the prompt's two rules carry besides the scroll counts, one
// function per slot. Plugins hook them with plugin.around and call
// render.request() when their text changes; a slot already taken is
// left to its owner. topCenter is Hal's activity word.
const slots = {
	topLeft: (): string => '',
	topCenter: (activity?: string): string => activity ?? '',
	topRight: (): string => '',
	bottomLeft: (): string => '',
	bottomCenter: (): string => '',
	bottomRight: (): string => '',
}

// A form field's placeholder in `fg` on `bg`, clipped to `width`. A
// fading edge (ansi.fades()) steps its last 3 glyphs toward `bg`,
// unless clipped. Ends in `back`.
function example(ex: Shown, fg: Oklch, bg: Oklch, width: number, back: Oklch | undefined): string {
	let text = ansi.clean(ex.text)
	if (width <= 0 || !text) return ''
	let end = back ? ansi.sgr({ fg: back }) : ''
	if (!ex.fade || !ansi.fades() || strings.visLen(text) > width)
		return ansi.sgr({ fg }) + strings.clipVisual(text, width) + end
	let g = placeholders.graphemes(text)
	let n = Math.min(3, g.length)
	let mix = (t: number): Oklch => [fg[0] + (bg[0] - fg[0]) * t, fg[1] + (bg[1] - fg[1]) * t, fg[2]]
	let faded = g
		.slice(g.length - n)
		.map((c, i) => ansi.sgr({ fg: mix((i + 1) / (n + 1)) }) + c)
		.join('')
	return ansi.sgr({ fg }) + g.slice(0, g.length - n).join('') + faded + end
}

// The prompt box, unmarked (no '> ', no indent): its rows scrolled to show the cursor (`scroll` is
// where it was), how many rows it hides above and below, all its rows
// (`total`) and the most it shows before scrolling (`limit`). Rows are
// marked, not yet painted.
function box(
	st: PromptState,
	width: number,
): {
	above: number
	rows: string[]
	below: number
	total: number
	limit: number
	row: number
	col: number
	scroll: number
} {
	let p = promptView.layoutPrompt(st.text, st.cursor, Math.max(1, width), prompt.selection(st))
	let height = st.rows ?? promptLayout.autoHeight(p.rows.length, settings.promptRows())
	let vp = promptLayout.viewport(st.scroll ?? 0, height, p.rows.length, p.row)
	let shown = p.rows.slice(vp.top, vp.top + height)
	while (shown.length < height) shown.push('')
	return {
		above: vp.above,
		rows: shown,
		below: vp.below,
		total: p.rows.length,
		limit: st.rows ?? settings.promptRows(),
		row: p.row - vp.top,
		col: p.col,
		scroll: vp.top,
	}
}

export const promptView = {
	layoutPrompt,
	rule,
	slots,
	example,
	box,
}
