// The prompt as the frame shows it: its markers, how its text lays out
// in rows with the cursor among them, and the scrolling box around
// them. Pure.

import { ansi } from './ansi.ts'
import { colors } from '../common/colors.ts'
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
function layoutPrompt(text: string, cursor: number, width: number, sel?: { start: number; end: number }): { rows: string[]; row: number; col: number } {
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

// A full-width rule `cols` wide: `left` at its left end and `center`
// in the middle (pushed right of `left` when they would meet), clipped
// to fit. Unpainted.
function rule(cols: number, left = '', center = ''): string {
	let l = left ? ` ${left} ` : ''
	let c = center ? strings.clipVisual(` ${center} `, cols) : ''
	let cw = strings.visLen(c)
	l = strings.clipVisual(l, Math.max(0, cols - cw))
	let lw = strings.visLen(l)
	let at = Math.max(lw, Math.floor((cols - cw) / 2))
	return l + '─'.repeat(at - lw) + c + '─'.repeat(Math.max(0, cols - at - cw))
}

// An example in `fg` on `bg` from column `from` (where the text before
// it ends) to `width`: its cut blank, then its text, clipped. A fading
// edge (ansi.fades()) steps its last or first 3 glyphs toward `bg`,
// unless clipped. Ends in `back`.
function example(ex: Shown, fg: Oklch, bg: Oklch, width: number, back: Oklch | undefined, from = 0): string {
	let pad = Math.max(0, strings.visLen(ex.cut) - from)
	let room = width - from - pad
	let text = ansi.clean(ex.text)
	if (room <= 0 || !text) return ''
	let end = back ? ansi.sgr({ fg: back }) : ''
	if (!ex.fade || !ansi.fades() || strings.visLen(text) > room) return ' '.repeat(pad) + ansi.sgr({ fg }) + strings.clipVisual(text, room) + end
	let g = placeholders.graphemes(text)
	let n = Math.min(3, g.length)
	let mix = (t: number): Oklch => [fg[0] + (bg[0] - fg[0]) * t, fg[1] + (bg[1] - fg[1]) * t, fg[2]]
	let faded = (s: string[], t: (i: number) => number) => s.map((c, i) => ansi.sgr({ fg: mix(t(i)) }) + c).join('')
	let body = ansi.sgr({ fg })
	let out = ex.fade === 'right'
		? body + g.slice(0, g.length - n).join('') + faded(g.slice(g.length - n), (i) => (i + 1) / (n + 1))
		: faded(g.slice(0, n), (i) => (n - i) / (n + 1)) + body + g.slice(n).join('')
	return ' '.repeat(pad) + out + end
}

// The prompt box, unmarked (no '> ', no indent): its rows scrolled to show the cursor (`scroll` is
// where it was), how many rows it hides above and below, all its rows
// (`total`), the most it shows before scrolling (`limit`), and a dim
// example: on an empty prompt, or right of one typed row while the
// example erases from its left. Rows are marked, not yet painted.
function box(
	st: PromptState,
	width: number,
	placeholder?: Shown,
): { above: number; rows: string[]; below: number; total: number; limit: number; row: number; col: number; scroll: number } {
	let p = promptView.layoutPrompt(st.text, st.cursor, Math.max(1, width), prompt.selection(st))
	let height = st.rows ?? promptLayout.autoHeight(p.rows.length, settings.promptRows())
	let vp = promptLayout.viewport(st.scroll ?? 0, height, p.rows.length, p.row)
	let shown = p.rows.slice(vp.top, vp.top + height)
	while (shown.length < height) shown.push('')
	let input = colors.input()
	if (placeholder && (!st.text || p.rows.length === 1)) shown[0] += promptView.example(placeholder, input.placeholder!, input.bg!, width, input.fg, strings.visLen(shown[0]!))
	return { above: vp.above, rows: shown, below: vp.below, total: p.rows.length, limit: st.rows ?? settings.promptRows(), row: p.row - vp.top, col: !st.text && placeholder ? 0 : p.col, scroll: vp.top }
}

// Text rows marked as a prompt: the first with `FIRST`, the rest indented.
function mark(rows: string[]): string[] {
	return rows.map((l, i) => (i ? promptView.REST : promptView.FIRST) + l)
}

export const promptView = {
	FIRST: '> ',
	REST: '  ',
	layoutPrompt,
	rule,
	example,
	box,
	mark,
}
