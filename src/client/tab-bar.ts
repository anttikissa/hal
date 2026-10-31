// The tab bar row above the prompt (tasks/cc/terminal.md, Tabs): roomy
// labels (` 2 `, the focused one `[2]`), else tight ones (`1 2 3`, the
// focused number underlined); a mark after a number adds one column.
// Switching tabs moves no number; only a mark coming or going does.
// Indicators follow the old Hal's tabIndicator; the blinking ones go
// with the shared pulse (pulse.ts): `lit` says which phase to draw.
// It stays one row: hints go from the lowest priority up, then the
// tabs come in pages of equal cells (common/tab-pages.ts, task 3k)
// between two display-only edges at the row's ends; a cell is never
// clipped. Each number is an OSC 8 link to that tab's web page.

import { colors } from '../common/colors.ts'
import type { Oklch } from '../common/oklch.ts'
import type { Tab } from '../common/protocol.ts'
import { strings } from '../common/strings.ts'
import { tabMark, type Mark } from '../common/tab-mark.ts'
import { tabPages } from '../common/tab-pages.ts'
import { ansi } from './ansi.ts'

// `over`: the project color drawn above this part (task 22).
type Part = { text: string; fg?: Oklch; link?: string; dim?: Oklch; under?: boolean; over?: Oklch; alt?: Oklch }
type Hint = { text: string; priority: number }

// The mark after a tab's number (common/tab-mark.ts, shared with the
// web), its color and, if it blinks, `dim`: its color in the dark
// phase. A working tab with background jobs alternates with `alt`,
// bash's magenta, every other blink.
const indicator = (tab: Tab): Part | undefined => {
	let m = tabMark.mark(tab)
	return m && tabBar.markPart(m)
}

function markPart(m: Mark): Part {
	let c = colors.tab()
	let hal = colors.assistant()
	let fg: Oklch = {
		asking: c.doneFg!,
		approval: c.warningFg!,
		blocked: c.warningFg!,
		retrying: c.warningFg!,
		working: hal.cursor!,
		jobs: c.jobsFg!,
		failed: c.errorFg!,
		paused: c.pausedFg!,
		done: c.doneFg!,
	}[m.kind]
	if (!m.blinks) return { text: m.glyph, fg }
	return {
		text: m.glyph,
		fg,
		dim: m.kind === 'working' ? hal.cursorIdle! : colors.blinkDim(fg),
		...(m.jobs && { alt: c.jobsFg! }),
	}
}

// Whether any tab in `list` has a blinking indicator.
const blinks = (list: Tab[]): boolean => list.some((t) => !!tabBar.indicator(t)?.dim)

// A blinking mark in its dark phase: dimmer, or gone where the dim
// color would look the same as the lit one (a monochrome terminal).
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

// A mark drawn lit or dark, or a blank marker slot. `alt`: the other
// color's turn for a mark that alternates (background jobs).
const slot = (mark: Part | undefined, lit: boolean, alt = false): Part =>
	!mark ? { text: ' ' } : mark.dim && !lit ? dark(mark) : alt && mark.alt ? { ...mark, fg: mark.alt } : mark

// Tabs start..end-1 as labels: roomy (` 2 `, `[2]`) or tight (`2`, one
// space apart, the focused number underlined). A mark follows the number.
function labels(
	list: Tab[],
	focused: string | undefined,
	roomy: boolean,
	lit: boolean,
	alt: boolean,
	start = 0,
	end = list.length,
): Part[] {
	let c = colors.tab()
	let parts: Part[] = []
	for (let i = start; i < end; i++) {
		let tab = list[i]!
		let on = tab.id === focused
		let fg = on ? c.activeFg! : c.inactiveFg!
		let over = tab.color === undefined ? undefined : colors.project()[`p${tab.color}`]
		let mark = tabBar.indicator(tab)
		let label: Part[] = [
			{ text: String(i + 1), fg, link: `/${tab.id}`, under: on && !roomy, over },
			...(mark ? [{ ...slot(mark, lit, alt), over }] : []),
		]
		if (roomy) parts.push({ text: on ? '[' : ' ', fg }, ...label, { text: on ? ']' : ' ', fg })
		else parts.push(...(i > start ? [{ text: ' ' }] : []), ...label)
	}
	return parts
}

// The page of tight labels holding tab `at` in `room` columns: pages
// fill greedily from tab 1, and the last one ends at the last tab, full.
// A pure function of the tabs and their marks, never of history.
function page(list: Tab[], at: number, room: number): { start: number; end: number } {
	let n = list.length
	let w = (i: number) => String(i + 1).length + (tabBar.indicator(list[i]!) ? 1 : 0)
	let start = 0
	let end = 0
	for (;;) {
		let used = w(start)
		end = start + 1
		while (end < n && used + 1 + w(end) <= room) used += 1 + w(end++)
		if (at < end || end >= n) break
		start = end
	}
	if (end < n) return { start, end }
	let used = w(n - 1)
	start = n - 1
	while (start > 0 && used + 1 + w(start - 1) <= room) used += 1 + w(--start)
	return { start, end: n }
}

// An edge like the web's: ‹ or › and the side's most urgent mark, no
// count; the arrow dimmed when that side is empty.
function edge(side: Tab[], left: boolean, lit: boolean, alt = false): Part[] {
	let fg = colors.status().fg!
	let mark = tabPages.urgent(side)
	let m = mark && tabBar.markPart(mark)
	return [{ text: left ? '‹' : '›', fg: side.length ? fg : colors.blinkDim(fg) }, slot(m, lit, alt)]
}

const plain = (parts: Part[]) => parts.map((p) => p.text).join('')

// The parts that fit in `width` columns, trying ever plainer bars;
// blinking indicators drawn lit or dark, alternating ones in `alt`.
function fit(list: Tab[], focused: string | undefined, width: number, lit = true, alt = false): Part[] {
	let dim = colors.status().fg!
	for (let roomy of [true, false]) {
		let all = labels(list, focused, roomy, lit, alt)
		let left = [...hints(list.length)]
		let gap = roomy ? ' ' : '  '
		for (;;) {
			let parts = left.length ? [...all, { text: gap + left.map((h) => h.text).join(', '), fg: dim }] : all
			if (strings.visLen(plain(parts)) <= width) return parts
			if (!left.length) break
			let low = left.reduce((a, b) => (b.priority < a.priority ? b : a))
			left = left.filter((h) => h !== low)
		}
	}
	// Left edge: arrow, mark, gap; right edge: gap, arrow, mark, flush
	// with the row's end, the spare columns before it.
	let at = Math.max(
		0,
		list.findIndex((t) => t.id === focused),
	)
	let p = page(list, at, width - 6)
	let mid = labels(list, focused, false, lit, alt, p.start, p.end)
	let spare = Math.max(0, width - 5 - strings.visLen(plain(mid)))
	return [
		...edge(list.slice(0, p.start), true, lit, alt),
		{ text: ' ' },
		...mid,
		{ text: ' '.repeat(spare) },
		...edge(list.slice(p.end), false, lit, alt),
	]
}

const UNDER = '\x1b[4m'
const UNUNDER = '\x1b[24m'

// The painted row for a terminal `cols` wide.
function row(list: Tab[], focused: string | undefined, cols: number, lit = true, alt = false): string {
	let width = Math.max(1, cols - 2 * ansi.PAD.length)
	// A tab's number links to its web page (task e3).
	let out = fit(list, focused, width, lit, alt).map((p) => {
		let text = p.link ? `\x1b]8;;${ansi.webUrl(p.link)}\x07${p.text}${ansi.LINK_OFF}` : p.text
		// Underline is no color: it marks the focused tab in a monochrome
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

export const tabBar = { indicator, markPart, blinks, hints, page, fit, row, overRow }
