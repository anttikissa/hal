// The prompt as the frame shows it: its markers, how its text lays out
// in rows with the cursor among them, and the scrolling box around
// them. Pure.

import { ansi } from './ansi.ts'
import { promptLayout } from '../common/prompt-layout.ts'
import type { PromptState } from '../common/prompt.ts'
import { settings } from '../common/settings.ts'
import { strings } from '../common/strings.ts'

/**
 * Lay out prompt text in rows of `width` columns, as Up/Down see it
 * (common/prompt-layout.ts), tabs drawn as spaces, and find the row and
 * column of the cursor offset.
 */
function layoutPrompt(text: string, cursor: number, width: number): { rows: string[]; row: number; col: number } {
	let list = promptLayout.rows(text, width)
	let clean = ansi.clean(text)
	// A tab or wide glyph alone on a row narrower than itself is cut.
	let rows = list.map((r) => strings.sliceVisual(strings.expandTabs(clean.slice(r.start, r.end)), 0, width))
	let at = promptLayout.position(text, list, cursor)
	return { rows, row: at.row, col: Math.min(at.col, width) }
}

// A dim rule across the box's edge, saying how many rows it hides.
function rule(label: string, width: number): string {
	let head = strings.clipVisual(`── ${label} `, width)
	return ansi.DIM + head + '─'.repeat(Math.max(0, width - strings.visLen(head))) + ansi.UNDIM
}

// The prompt box: its rows scrolled to show the cursor (`scroll` is
// where it was), rules above and below saying what it hides, and a
// dim example on an empty prompt. Rows are marked, not yet painted.
function box(
	st: PromptState,
	width: number,
	placeholder?: string,
): { above?: string; rows: string[]; below?: string; row: number; col: number; scroll: number } {
	let textWidth = Math.max(1, width - promptView.FIRST.length)
	let p = promptView.layoutPrompt(st.text, st.cursor, textWidth)
	let height = st.rows ?? promptLayout.autoHeight(p.rows.length, settings.promptRows())
	let vp = promptLayout.viewport(st.scroll ?? 0, height, p.rows.length, p.row)
	let shown = promptView.mark(p.rows).slice(vp.top, vp.top + height)
	while (shown.length < height) shown.push(promptView.REST)
	if (!st.text && placeholder) shown[0] = promptView.FIRST + ansi.DIM + strings.clipVisual(ansi.clean(placeholder), textWidth) + ansi.UNDIM
	let out: ReturnType<typeof box> = { rows: shown, row: p.row - vp.top, col: promptView.FIRST.length + p.col, scroll: vp.top }
	if (vp.above) out.above = promptView.rule(`up ${vp.above}`, width)
	if (vp.below) out.below = promptView.rule(`down ${vp.below}`, width)
	return out
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
	box,
	mark,
}
