// Dim example requests shown in an empty prompt, so a new user has
// something concrete to try. They rotate (erase, type the next); the
// Hal repo has its own list.

import { strings } from './strings.ts'

const general = [
	'Analyze the project in this directory',
	'What tools do you have available?',
	'Explain the git history of the last week',
	'Find and fix the flakiest test',
	'What would you refactor first here, and why?',
	'Write a README for this project',
]

const hal = [
	'Add one second precision to message timestamps',
	"Make the tab bar show each session's model",
	'Which module is closest to the 400-line limit?',
	'Add a /uptime command that shows when the host process started',
	'Implement a plugin that uses Jev to decide the best model for subagent based on its initial prompt',
	'What tools do you have available?',
	'Explain the git history of the last week',
]

// An example as drawn: `cut`, graphemes already erased from its left,
// is drawn blank so `text` keeps its columns; `fade`: the edge being
// erased, drawn fading where the client can (terminal: ansi.fades());
// `next`: ms until it changes (Infinity: never).
export type Shown = { cut: string; text: string; fade?: 'left' | 'right'; next: number }

// A rotating example (a form field's placeholder list) `ms` after it
// appeared: hold one, erase it a grapheme at a time, type the next, in
// list order, round and round. A long one (over 50 graphemes) holds
// longer, so there is time to read it.
const HOLD = 3000
const LONG_HOLD = 4500
const ERASE = 5
const TYPE = 35 / 3
// Each list's graphemes and cycle length, computed once: rotate runs on
// every repaint (every few ms while typing), so its cost must not grow
// with the time the form has been open.
const segmenter = new Intl.Segmenter()
const cycles = new WeakMap<string[], { items: string[][]; total: number }>()
const graphemes = (s: string): string[] => [...segmenter.segment(s)].map((g) => g.segment)

function cycle(list: string[]) {
	let c = cycles.get(list)
	if (c) return c
	let items = list.map(graphemes)
	let total = items.reduce((sum, shown, i) => sum + (shown.length > 50 ? LONG_HOLD : HOLD) + shown.length * ERASE + items[(i + 1) % items.length]!.length * TYPE, 0)
	cycles.set(list, (c = { items, total }))
	return c
}

function rotate(list: string[], ms: number): Shown {
	if (list.length < 2) return { cut: '', text: list[0] ?? '', next: Infinity }
	let { items, total } = cycle(list)
	ms %= total
	for (let i = 0; ; i = (i + 1) % list.length) {
		let shown = items[i]!
		let coming = items[(i + 1) % list.length]!
		let hold = shown.length > 50 ? LONG_HOLD : HOLD
		let erase = shown.length * ERASE
		if (ms < hold) return { cut: '', text: shown.join(''), next: hold - ms }
		ms -= hold
		if (ms < erase) return { cut: '', text: shown.slice(0, shown.length - Math.floor(ms / ERASE) - 1).join(''), fade: 'right', next: ERASE - (ms % ERASE) }
		ms -= erase
		if (ms < coming.length * TYPE) return { cut: '', text: coming.slice(0, Math.floor(ms / TYPE) + 1).join(''), next: TYPE - (ms % TYPE) }
		ms -= coming.length * TYPE
	}
}

// The main prompt's example. `key`: whose prompt (a session); `since`:
// when its box was first seen empty, the rotation's clock; `gone`: the
// example shown when typing started, and when, now erasing from its
// left at the erase speed (a prototype).
export type PromptExample = { key?: string; since?: number; gone?: { items: string[]; at: number } }

// The example over prompt `key` holding `typed` at `now`, from `list`
// (none: no example); updates `st`. The typed text covers the example's
// first columns, so only what lies right of it shows.
function follow(st: PromptExample, key: string, list: string[] | undefined, typed: string, now: number): Shown | undefined {
	if (st.key !== key || !list) {
		for (let k of Object.keys(st)) delete st[k as keyof PromptExample]
		st.key = key
	}
	if (!list) return undefined
	if (!typed) {
		st.gone = undefined
		st.since ??= now
		return rotate(list, now - st.since)
	}
	if (st.since !== undefined) {
		st.gone = { items: graphemes(rotate(list, now - st.since).text), at: now }
		st.since = undefined
	}
	let g = st.gone
	if (!g || typed.includes('\n')) return undefined
	let n = Math.floor((now - g.at) / ERASE) + 1
	let covered = strings.visLen(typed)
	while (n < g.items.length && strings.visLen(g.items.slice(0, n).join('')) <= covered) n++
	if (n >= g.items.length) {
		st.gone = undefined
		return undefined
	}
	return { cut: g.items.slice(0, n).join(''), text: g.items.slice(n).join(''), fade: 'left', next: ERASE - ((now - g.at) % ERASE) }
}

export const placeholders = { general, hal, graphemes, rotate, follow }
