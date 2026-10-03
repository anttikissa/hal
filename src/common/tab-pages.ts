// Which tabs a tab strip shows (task 3k), the same arithmetic for the
// terminal's tab bar and the web's strip. Every cell has one width, so
// Ctrl-N/P move one cell and no number shifts. Names show only when
// every tab fits with one; else numbers; when not even those fit, the
// tabs come in fixed pages (1..k, k+1..2k, ..., the last one ending at
// the last tab) between two edges of fixed width, and the page shown is the one holding the current tab:
// a pure function of (count, current, width), never of history.
// Widths are in any one unit: terminal columns, CSS pixels.

import type { Tab } from './protocol.ts'
import { tabMark, type Mark, type MarkKind } from './tab-mark.ts'

// A side's edge: how many tabs lie there and the most urgent mark.
export type Edge = { count: number; mark?: Mark }
// What to draw: tabs start..end-1, with names or not, and the edges
// when paged (an edge with count 0 is drawn blank at its width).
export type Page = { names: boolean; start: number; end: number; left?: Edge; right?: Edge }
// A cell without and with a name, and an edge.
export type Sizes = { cell: number; named?: number; edge: number }

// Characters in the widest number, the width of a cell's number part.
const digits = (count: number): number => String(Math.max(1, count)).length

// Failed over asking over attention over working; done marks never.
const rank: Record<MarkKind, number> = { failed: 5, asking: 4, paused: 3, noticed: 2, working: 1, done: 0 }

function urgent(tabs: Tab[]): Mark | undefined {
	let best: Mark | undefined
	for (let t of tabs) {
		let m = tabMark.mark(t)
		if (m && rank[m.kind] > 0 && (!best || rank[m.kind] > rank[best.kind])) best = m
	}
	return best
}

function page(tabs: Tab[], current: number, width: number, sizes: Sizes): Page {
	let n = tabs.length
	if (sizes.named !== undefined && n * sizes.named <= width) return { names: true, start: 0, end: n }
	if (n * sizes.cell <= width) return { names: false, start: 0, end: n }
	let per = Math.max(1, Math.floor((width - 2 * sizes.edge) / sizes.cell))
	let start = Math.floor(Math.max(0, Math.min(current, n - 1)) / per) * per
	// The last page ends at the last tab and is full like the others,
	// overlapping the one before, so no strip ends in empty room.
	if (start + per > n) start = Math.max(0, n - per)
	let end = Math.min(n, start + per)
	let edge = (side: Tab[]): Edge => {
		let mark = tabPages.urgent(side)
		return mark ? { count: side.length, mark } : { count: side.length }
	}
	return { names: false, start, end, left: edge(tabs.slice(0, start)), right: edge(tabs.slice(end)) }
}

export const tabPages = { digits, urgent, page }
