// The tab bar row above the prompt (tasks/cc/terminal.md, Tabs):
// "Tabs:", one equal cell per tab (its number right-aligned, a marker
// slot, a gap; the focused number underlined), then key hints.
// Indicators follow the old Hal's tabIndicator; the blinking ones go
// with the shared pulse (pulse.ts): `lit` says which phase to draw.
// It stays one row: hints go from the lowest priority up, then the
// label, then the tabs come in pages (common/tab-pages.ts, task 3k)
// between two display-only edges; a cell is never clipped.
// Each number is an OSC 8 link to that tab's web page.

import { colors } from '../common/colors.ts'
import type { Oklch } from '../common/oklch.ts'
import type { Tab } from '../common/protocol.ts'
import { strings } from '../common/strings.ts'
import { tabMark, type Mark } from '../common/tab-mark.ts'
import { tabPages, type Edge } from '../common/tab-pages.ts'
import { ansi } from './ansi.ts'

// `over`: the project color drawn above this part (task 22).
type Part = { text: string; fg?: Oklch; link?: string; dim?: Oklch; under?: boolean; over?: Oklch }
type Hint = { text: string; priority: number }

// The mark after a tab's number (common/tab-mark.ts, shared with the
// web), its colour and, if it blinks, `dim`: its colour in the dark
// phase.
const indicator = (tab: Tab): Part | undefined => {
	let m = tabMark.mark(tab)
	return m && tabBar.markPart(m)
}

function markPart(m: Mark): Part {
	let c = colors.tab()
	let hal = colors.assistant()
	let fg: Oklch = { asking: c.warningFg!, noticed: c.warningFg!, working: hal.cursor!, failed: c.errorFg!, paused: c.pausedFg!, done: c.doneFg! }[m.kind]
	if (!m.blinks) return { text: m.glyph, fg }
	return { text: m.glyph, fg, dim: m.kind === 'working' ? hal.cursorIdle! : colors.blinkDim(fg) }
}

// Whether any tab in `list` has a blinking indicator.
const blinks = (list: Tab[]): boolean => list.some((t) => !!tabBar.indicator(t)?.dim)

// A blinking mark in its dark phase: dimmer, or gone where the dim
// colour would look the same as the lit one (a monochrome terminal).
function dark(mark: Part): Part {
	let dim = mark.dim!
	if (ansi.sgr({ fg: dim }) === ansi.sgr({ fg: mark.fg! })) return { text: ' '.repeat(strings.visLen(mark.text)) }
	return { text: mark.text, fg: dim }
}

// Key hints: creating with one tab, moving between several.
function hints(count: number): Hint[] {
	if (count <= 1) return [{ text: 'ctrl-t: new', priority: 1 }]
	return [
		{ text: 'alt-#: goto', priority: 3 },
		{ text: 'ctrl-n/p: switch', priority: 2 },
		{ text: 'ctrl-w: close', priority: 1 },
	]
}

// A mark drawn lit or dark, or a blank marker slot.
const slot = (mark: Part | undefined, lit: boolean): Part => (!mark ? { text: ' ' } : mark.dim && !lit ? dark(mark) : mark)

// Tabs start..end-1 as cells of one width: number, marker slot, gap.
function cells(list: Tab[], focused: string | undefined, start: number, end: number, lit: boolean): Part[] {
	let c = colors.tab()
	let d = tabPages.digits(list.length)
	let parts: Part[] = []
	for (let i = start; i < end; i++) {
		let tab = list[i]!
		let on = tab.id === focused
		let n = String(i + 1)
		let over = tab.color === undefined ? undefined : colors.project()[`p${tab.color}`]
		parts.push({ text: ' '.repeat(d - n.length), over }, { text: n, fg: on ? c.activeFg! : c.inactiveFg!, link: `/${tab.id}`, under: on, over })
		parts.push({ ...slot(tabBar.indicator(tab), lit), over }, { text: ' ' })
	}
	return parts
}

// An edge `width` wide: ‹N or N› and the side's most urgent mark, or
// blanks when that side is empty.
function edge(e: Edge, left: boolean, width: number, lit: boolean): Part[] {
	if (!e.count) return [{ text: ' '.repeat(width) }]
	let text = left ? `‹${e.count}` : `${e.count}›`
	let m = e.mark && tabBar.markPart(e.mark)
	let pad = ' '.repeat(Math.max(0, width - text.length - 2))
	let parts: Part[] = [{ text: left ? text : pad + text, fg: colors.status().fg! }, slot(m, lit), { text: ' ' }]
	if (left) parts.push({ text: pad })
	return parts
}

const plain = (parts: Part[]) => parts.map((p) => p.text).join('')

// The parts that fit in `width` columns, trying ever plainer bars;
// blinking indicators drawn lit or dark.
function fit(list: Tab[], focused: string | undefined, width: number, lit = true): Part[] {
	let dim = colors.status().fg!
	let all = cells(list, focused, 0, list.length, lit)
	let left = [...hints(list.length)]
	let bar = (label: boolean, hs: Hint[]): Part[] => [
		...(label ? [{ text: 'Tabs: ', fg: dim }] : []),
		...all,
		...(hs.length ? [{ text: ` ${hs.map((h) => h.text).join(', ')}`, fg: dim }] : []),
	]
	for (;;) {
		let parts = bar(true, left)
		if (strings.visLen(plain(parts)) <= width) return parts
		if (!left.length) break
		let low = left.reduce((a, b) => (b.priority < a.priority ? b : a))
		left = left.filter((h) => h !== low)
	}
	if (strings.visLen(plain(all)) <= width) return all
	let d = tabPages.digits(list.length)
	let sizes = { cell: d + 2, edge: d + 3 }
	let at = list.findIndex((t) => t.id === focused)
	let p = tabPages.page(list, at, width, sizes)
	return [...edge(p.left!, true, sizes.edge, lit), ...cells(list, focused, p.start, p.end, lit), ...edge(p.right!, false, sizes.edge, lit)]
}

const UNDER = '\x1b[4m'
const UNUNDER = '\x1b[24m'

// The painted row for a terminal `cols` wide.
function row(list: Tab[], focused: string | undefined, cols: number, lit = true): string {
	let width = Math.max(1, cols - 2 * ansi.PAD.length)
	// A tab's number links to its web page (task e3).
	let out = fit(list, focused, width, lit).map((p) => {
		let text = p.link ? `\x1b]8;;${ansi.webUrl(p.link)}\x07${p.text}${ansi.LINK_OFF}` : p.text
		// Underline is no colour: it marks the focused tab in a monochrome
		// terminal too.
		if (p.under) text = UNDER + text + UNUNDER
		return (p.fg ? ansi.sgr({ fg: p.fg }) : '') + text
	})
	return ansi.PAD + out.join('') + ansi.UNCOLOR
}

// The row above the tab bar: each cell's project color as ▁ over its
// number and marker slot; none when no tab has a color.
function overRow(list: Tab[], focused: string | undefined, cols: number): string | undefined {
	if (!list.some((t) => t.color !== undefined)) return undefined
	let width = Math.max(1, cols - 2 * ansi.PAD.length)
	let out = fit(list, focused, width).map((p) => {
		let n = strings.visLen(p.text)
		return p.over ? ansi.sgr({ fg: p.over }) + '▁'.repeat(n) + ansi.UNCOLOR : ' '.repeat(n)
	})
	return ansi.PAD + out.join('')
}

export const tabBar = { indicator, markPart, blinks, hints, fit, row, overRow }
