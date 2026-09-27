// The tab bar row above the prompt (tasks/cc/terminal.md, Tabs):
// "Tabs:", a numeric label per tab with the focused one in brackets and
// one indicator character when the tab needs a look, then key hints.
// It stays one row: hints go from the lowest priority up, then the
// label, then the padding between tabs, and only then is it clipped.

import { colors } from '../common/colors.ts'
import type { Oklch } from '../common/oklch.ts'
import type { Tab } from '../common/protocol.ts'
import { strings } from '../common/strings.ts'
import { ansi } from './ansi.ts'

type Part = { text: string; fg?: Oklch }
type Hint = { text: string; priority: number }

// The one character after a tab's number, if any, and its colour.
function indicator(tab: Tab): Part | undefined {
	let c = colors.tab()
	let s = tab.state
	if (s.type === 'blocked') return { text: '!', fg: c.warningFg! }
	if (s.type === 'error') return { text: '✗', fg: c.errorFg! }
	if (s.type === 'running' || s.type === 'retrying') return { text: '▪', fg: c.activeFg! }
	if (tab.attention) return { text: '◆', fg: c.warningFg! }
	return undefined
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

function labels(list: Tab[], focused: string | undefined, compact: boolean): Part[] {
	let c = colors.tab()
	let parts: Part[] = []
	list.forEach((tab, i) => {
		let on = tab.id === focused
		let fg = on ? c.activeFg! : c.inactiveFg!
		let mark = indicator(tab)
		if (compact && i > 0) parts.push({ text: ' ' })
		parts.push({ text: on ? '[' : compact ? '' : ' ', fg }, { text: String(i + 1), fg })
		if (mark) parts.push(mark)
		parts.push({ text: on ? ']' : compact ? '' : ' ', fg })
	})
	return parts
}

const plain = (parts: Part[]) => parts.map((p) => p.text).join('')

// The parts that fit in `width` columns, trying ever plainer bars.
function fit(list: Tab[], focused: string | undefined, width: number): Part[] {
	let dim = colors.status().fg!
	let tabs = labels(list, focused, false)
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
	for (let parts of [bar(false, []), bar(false, [], labels(list, focused, true))]) if (strings.visLen(plain(parts)) <= width) return parts
	// Still too wide: clip the compact bar.
	let text = strings.clipVisual(plain(bar(false, [], labels(list, focused, true))), width)
	return [{ text, fg: dim }]
}

// The painted row for a terminal `cols` wide.
function row(list: Tab[], focused: string | undefined, cols: number): string {
	let width = Math.max(1, cols - 2 * ansi.PAD.length)
	let out = fit(list, focused, width).map((p) => (p.fg ? ansi.sgr({ fg: p.fg }) : '') + p.text)
	return ansi.PAD + out.join('') + ansi.UNCOLOR
}

export const tabBar = { indicator, hints, fit, row }
