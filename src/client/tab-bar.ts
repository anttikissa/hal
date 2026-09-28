// The tab bar row above the prompt (tasks/cc/terminal.md, Tabs):
// "Tabs:", a numeric label per tab with the focused one in brackets and
// one indicator character when the tab needs a look, then key hints.
// Indicators follow the old Hal's tabIndicator; the blinking ones go
// with the shared pulse (pulse.ts): `lit` says which phase to draw.
// It stays one row: hints go from the lowest priority up, then the
// label, then the padding between tabs, and only then is it clipped.
// Each number is an OSC 8 link to that tab's web page.

import { colors } from '../common/colors.ts'
import type { Oklch } from '../common/oklch.ts'
import type { Tab } from '../common/protocol.ts'
import { strings } from '../common/strings.ts'
import { tabMark } from '../common/tab-mark.ts'
import { ansi } from './ansi.ts'

type Part = { text: string; fg?: Oklch; link?: string; dim?: Oklch }
type Hint = { text: string; priority: number }

// The mark after a tab's number (common/tab-mark.ts, shared with the
// web), its colour and, if it blinks, `dim`: its colour in the dark
// phase.
function indicator(tab: Tab): Part | undefined {
	let m = tabMark.mark(tab)
	if (!m) return undefined
	let c = colors.tab()
	let hal = colors.assistant()
	let darker = ([L, C, h]: Oklch): Oklch => [L * 0.65, C, h]
	let fg: Oklch = { asking: c.warningFg!, noticed: c.warningFg!, working: hal.cursor!, failed: c.errorFg!, paused: c.pausedFg!, done: c.doneFg! }[m.kind]
	if (!m.blinks) return { text: m.glyph, fg }
	return { text: m.glyph, fg, dim: m.kind === 'working' ? hal.cursorIdle! : darker(fg) }
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

function labels(list: Tab[], focused: string | undefined, compact: boolean, lit: boolean): Part[] {
	let c = colors.tab()
	let parts: Part[] = []
	list.forEach((tab, i) => {
		let on = tab.id === focused
		let fg = on ? c.activeFg! : c.inactiveFg!
		let mark = tabBar.indicator(tab)
		if (compact && i > 0) parts.push({ text: ' ' })
		parts.push({ text: on ? '[' : compact ? '' : ' ', fg }, { text: String(i + 1), fg, link: `/${tab.id}` })
		if (mark) parts.push(mark.dim && !lit ? dark(mark) : mark)
		parts.push({ text: on ? ']' : compact ? '' : ' ', fg })
	})
	return parts
}

const plain = (parts: Part[]) => parts.map((p) => p.text).join('')

// The parts that fit in `width` columns, trying ever plainer bars;
// blinking indicators drawn lit or dark.
function fit(list: Tab[], focused: string | undefined, width: number, lit = true): Part[] {
	let dim = colors.status().fg!
	let tabs = labels(list, focused, false, lit)
	let left = [...hints(list.length)]
	let bar = (label: boolean, hs: Hint[], ts = tabs): Part[] => [
		...(label ? [{ text: 'Tabs: ', fg: dim }] : []),
		...ts,
		...(hs.length ? [{ text: `  ${hs.map((h) => h.text).join(', ')}`, fg: dim }] : []),
	]
	for (;;) {
		let parts = bar(true, left)
		if (strings.visLen(plain(parts)) <= width) return parts
		if (!left.length) break
		let low = left.reduce((a, b) => (b.priority < a.priority ? b : a))
		left = left.filter((h) => h !== low)
	}
	for (let parts of [bar(false, []), bar(false, [], labels(list, focused, true, lit))]) if (strings.visLen(plain(parts)) <= width) return parts
	// Still too wide: clip the compact bar.
	let text = strings.clipVisual(plain(bar(false, [], labels(list, focused, true, lit))), width)
	return [{ text, fg: dim }]
}

// The painted row for a terminal `cols` wide.
function row(list: Tab[], focused: string | undefined, cols: number, lit = true): string {
	let width = Math.max(1, cols - 2 * ansi.PAD.length)
	// A tab's number links to its web page (task e3).
	let out = fit(list, focused, width, lit).map((p) => {
		let text = p.link ? `\x1b]8;;${ansi.webUrl(p.link)}\x07${p.text}${ansi.LINK_OFF}` : p.text
		return (p.fg ? ansi.sgr({ fg: p.fg }) : '') + text
	})
	return ansi.PAD + out.join('') + ansi.UNCOLOR
}

export const tabBar = { indicator, blinks, hints, fit, row }
