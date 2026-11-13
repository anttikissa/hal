// A form field's rotating placeholder list (forms.ts): hold one, erase
// it a grapheme at a time, type the next.

// An example as drawn: `fade`: the edge being erased, drawn fading where
// the client can (terminal: ansi.fades()); `next`: ms until it changes
// (Infinity: never).
export type Shown = { text: string; fade?: 'right'; next: number }

// A rotating example `ms` after it appeared: hold one, erase it, type
// the next, in list order, round and round. A long one (over 50
// graphemes) holds longer, so there is time to read it.
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
	let total = items.reduce(
		(sum, shown, i) =>
			sum +
			(shown.length > 50 ? LONG_HOLD : HOLD) +
			shown.length * ERASE +
			items[(i + 1) % items.length]!.length * TYPE,
		0,
	)
	cycles.set(list, (c = { items, total }))
	return c
}

function rotate(list: string[], ms: number): Shown {
	if (list.length < 2) return { text: list[0] ?? '', next: Infinity }
	let { items, total } = cycle(list)
	ms %= total
	for (let i = 0; ; i = (i + 1) % list.length) {
		let shown = items[i]!
		let coming = items[(i + 1) % list.length]!
		let hold = shown.length > 50 ? LONG_HOLD : HOLD
		let erase = shown.length * ERASE
		if (ms < hold) return { text: shown.join(''), next: hold - ms }
		ms -= hold
		if (ms < erase)
			return {
				text: shown.slice(0, shown.length - Math.floor(ms / ERASE) - 1).join(''),
				fade: 'right',
				next: ERASE - (ms % ERASE),
			}
		ms -= erase
		if (ms < coming.length * TYPE)
			return { text: coming.slice(0, Math.floor(ms / TYPE) + 1).join(''), next: TYPE - (ms % TYPE) }
		ms -= coming.length * TYPE
	}
}

export const placeholders = { graphemes, rotate }
