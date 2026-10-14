// Expanding and collapsing transcript blocks (tasks ghs, r4d, v8y, hyt):
// which blocks a /toggle, /expand or /collapse target names, what each
// does to them, and the two states a block switches between. Pure; each
// client keeps its blocks' states in memory, never stored or synced.

import { titles } from './titles.ts'
import { transcript, type Item, type Transcript } from './transcript.ts'
import { card, type Verbosity } from './card.ts'

export type Mode = 'toggle' | 'expand' | 'collapse'
// One target: kind letters and exact transcript keys, an inclusive
// range, or '*' (empty endpoints). Keys are identities, not decimals.
export type Part = { kinds: string; from: string; to: string; one: boolean; text: string }
// The parts; none means the latest tool block.
export type Target = Part[]
// Matched blocks and what happens to them: open or close all, or (one
// block toggled) `open` undefined, the block switches state.
export type Plan = { items: Item[]; open?: boolean }

// Kind letters (task 9p) and their words.
const kinds: Record<string, string> = { t: 'tool', r: 'thinking', a: 'assistant', u: 'user', m: 'message', s: 'system', q: 'question' }
// What a range or '*' without letters matches: never user or assistant blocks.
const unnamed = 'trmsq'

// References may be partial during completion; transcript.addressable
// validates complete keys using the same grammar as card links.
function reference(text: string): { hash: string; kinds: string; key: string } {
	let m = /^(#?)([a-z]*)(.*)$/i.exec(text)!
	return { hash: m[1]!, kinds: m[2]!.toLowerCase(), key: m[3]! }
}

function addressed(items: Item[]): Item[] {
	return items.filter((i) => transcript.addressable(i.key))
}

function compare(a: string, b: string, upper = false): number {
	let [recordA, indexA = 0] = a.split('.').map(Number)
	let [recordB, indexB = upper ? Infinity : 0] = b.split('.').map(Number)
	return recordA! - recordB! || indexA - indexB
}

function parse(args: string): Target | string {
	let parts: Part[] = []
	for (let text of args.trim().replace(/\s*-\s*/g, '-').split(/[\s,]+/).filter(Boolean)) {
		let ends = text.split('-').map(reference)
		let first = ends[0]!, last = ends.at(-1)!
		let star = ends.length === 1 && (first.key === '*' || !first.key && !!first.kinds)
		if (ends.length > 2 || (!star && ends.some((e) => !transcript.addressable(e.key)))) return `Not a card, range or kind: ${text}`
		let bad = ends.flatMap((e) => [...e.kinds]).find((c) => !kinds[c])
		if (bad) return `Unknown kind ${bad} in ${text} (kinds: ${Object.keys(kinds).join(' ')})`
		let [from, to] = star ? ['', ''] : compare(first.key, last.key) <= 0 ? [first.key, last.key] : [last.key, first.key]
		parts.push({ kinds: first.kinds, from: from!, to: to!, one: ends.length === 1 && !star, text })
	}
	return parts
}

// Whether `item` expands and collapses.
function toggles(item: Item): boolean {
	return card.toggles(item)
}

// The blocks `target` names in `items`, in transcript order, or why
// none; `verb` names the command in the error.
function resolve(items: Item[], target: Target, verb = 'toggle'): Item[] | string {
	let numbered = toggle.addressed(items)
	if (!target.length) {
		let tool = items.findLast((i) => i.type === 'tool')
		return tool ? [tool] : `No tool card to ${verb}`
	}
	let found = new Set<Item>()
	for (let part of target) {
		if (part.one) {
			let item = numbered.find((i) => i.key === part.from)
			if (!item) return `No card ${part.from} to ${verb}`
			if (!toggle.toggles(item)) return `Card ${part.from} does not expand or collapse`
			found.add(item)
			continue
		}
		let letters = part.kinds || unnamed
		for (let i of numbered) {
			let within = !part.from || compare(i.key, part.from) >= 0 && compare(i.key, part.to, true) <= 0
			if (toggle.toggles(i) && within && letters.includes(titles.letter(i))) found.add(i)
		}
	}
	if (!found.size) return `Nothing to ${verb} in ${target.map((p) => p.text).join(' ')}`
	return numbered.filter((i) => found.has(i))
}

// What `mode` with `args` does in `items`, `fold` giving each block's
// state now: /toggle switches one named block (or the latest tool
// block); for more it expands all when at least half are short, else
// collapses all (a tie expands: expanding hides nothing).
function plan(mode: Mode, items: Item[], args: string, fold: (item: Item) => Verbosity): Plan | string {
	let target = toggle.parse(args)
	if (typeof target === 'string') return target
	let found = toggle.resolve(items, target, mode)
	if (typeof found === 'string') return found
	if (mode !== 'toggle') return { items: found, open: mode === 'expand' }
	if (target.length <= 1 && (target[0]?.one ?? true)) return { items: found }
	let folded = found.filter((i) => fold(i) === 'short').length
	return { items: found, open: folded * 2 >= found.length }
}

// '3 thinking blocks', 'tool block', '5 blocks'.
function noun(items: Item[]): string {
	let letters = new Set(items.map((i) => titles.letter(i)))
	let kind = letters.size === 1 ? `${kinds[[...letters][0]!]} ` : ''
	return items.length === 1 ? `${kind}card` : `${items.length} ${kind}cards`
}

// The live hint: what Enter does ("Expand 12 tool cards: t4-t88").
// `fold` gives each block's state now.
function describe(p: Plan, fold: (item: Item) => Verbosity): string {
	let open = p.open ?? fold(p.items[0]!) === 'short'
	let ids = p.items.map((i) => titles.blockId(i))
	return `${open ? 'Expand' : 'Collapse'} ${toggle.noun(p.items)}${ids.length > 1 ? ':' : ''} ${ids.length > 6 ? `${ids[0]}-${ids.at(-1)}` : ids.join(', ')}`
}

// How each block of `t` starts: the session's overrides over this
// client's settings; a call counts as failed once its result says so
// (card.failed). Built once per use: it scans the items.
function starts(t: Pick<Transcript, 'items' | 'meta'>): (item: Item) => Verbosity {
	let bash = new Set<string>(), failed = new Set<string>()
	for (let i of t.items) {
		if (i.type === 'tool' && i.name === 'bash') bash.add(i.id)
		if (i.type === 'tool-result' && card.failed(i, bash.has(i.id))) failed.add(i.id)
	}
	return (item) => card.initial(item, t.meta.blocks, item.type === 'tool' && failed.has(item.id))
}

// The state after `now`: `open` true expands, false collapses,
// undefined switches.
function step(now: Verbosity, open?: boolean): Verbosity {
	return (open ?? now === 'short') ? 'long' : 'short'
}

function items(t: Pick<Transcript, 'items' | 'inbox'>): Item[] {
	return [...t.items, ...t.inbox.map((m) => transcript.waitingItem(m))]
}

// Applies `mode` with `args` to `states` (key → state), blocks not in
// it at `start`. Returns the keys changed, or why none.
function apply(mode: Mode, states: Map<string, Verbosity>, items: Item[], args: string, start: (item: Item) => Verbosity): string[] | string {
	let state = (i: Item) => states.get(i.key) ?? start(i)
	let p = toggle.plan(mode, items, args, state)
	if (typeof p === 'string') return p
	for (let i of p.items) states.set(i.key, toggle.step(state(i), p.open))
	return p.items.map((i) => i.key)
}

export const toggle = { kinds, reference, addressed, parse, toggles, resolve, plan, noun, describe, starts, step, items, apply }
