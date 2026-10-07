// Expanding and collapsing transcript blocks (tasks ghs, r4d, v8y):
// which blocks a /toggle, /expand or /collapse target names, what each
// does to them, and the states a block steps through. Pure; each
// client keeps its blocks' states in memory, never stored or synced.

import { attachments } from './attachments.ts'
import { titles } from './titles.ts'
import type { Item } from './transcript.ts'

// `inline`: a prompt open with its pastes' text in place of markers.
export type Fold = 'closed' | 'open' | 'inline'
export type Mode = 'toggle' | 'expand' | 'collapse'
// One item of a target: kind letters, then an inclusive range of block
// numbers (`one`: a single number, any kind; '*' is 0 to Infinity).
export type Part = { kinds: string; from: number; to: number; one: boolean; text: string }
// The parts; none means the latest tool block.
export type Target = Part[]
// Matched blocks and what happens to them: open or close all, or (one
// block toggled) `open` undefined, the block steps to its next state.
export type Plan = { items: Item[]; open?: boolean }

// Kind letters (task 9p) and their words.
const kinds: Record<string, string> = { t: 'tool', r: 'thinking', a: 'assistant', u: 'user', m: 'message', s: 'system', q: 'question' }
// What a range or '*' without letters matches: never user or assistant blocks.
const unnamed = 'trmsq'

// "t14,t16,t30-45", "#t14 16 30-45", "au10-40", "t*": items separated
// by commas, spaces or both. Returns the parts or why the text is not a target.
function parse(args: string): Target | string {
	let parts: Part[] = []
	for (let text of args.trim().replace(/\s*-\s*/g, '-').split(/[\s,]+/).filter(Boolean)) {
		let m = /^#?([a-z]*)(?:(\d+)(?:-#?[a-z]*(\d+))?|(\*))$/i.exec(text)
		if (!m) return `not a block, range or kind: ${text}`
		let letters = m[1]!.toLowerCase()
		let bad = [...letters].find((c) => !kinds[c])
		if (bad) return `unknown kind ${bad} in ${text} (kinds: ${Object.keys(kinds).join(' ')})`
		if (m[4]) parts.push({ kinds: letters, from: 0, to: Infinity, one: false, text })
		else {
			let a = Number(m[2]), b = m[3] === undefined ? a : Number(m[3])
			parts.push({ kinds: letters, from: Math.min(a, b), to: Math.max(a, b), one: m[3] === undefined, text })
		}
	}
	return parts
}

// Whether `item` expands and collapses.
function toggles(item: Item): boolean {
	return item.type === 'tool' || item.type === 'thinking' || item.type === 'text' || item.type === 'prompt' || (item.type === 'output' && !!item.change)
}

// The blocks `target` names in `items`, in transcript order, or why
// none; `verb` names the command in the error.
function resolve(items: Item[], target: Target, verb = 'toggle'): Item[] | string {
	let numbered = items.filter((i) => /^\d+$/.test(i.key))
	if (!target.length) {
		let tool = items.findLast((i) => i.type === 'tool')
		return tool ? [tool] : `no tool block to ${verb}`
	}
	let found = new Set<Item>()
	for (let part of target) {
		if (part.one) {
			let item = numbered.find((i) => Number(i.key) === part.from)
			if (!item) return `no block ${part.from} to ${verb}`
			if (!toggle.toggles(item)) return `block ${part.from} does not expand or collapse`
			found.add(item)
			continue
		}
		let letters = part.kinds || unnamed
		for (let i of numbered) {
			if (toggle.toggles(i) && Number(i.key) >= part.from && Number(i.key) <= part.to && letters.includes(titles.letter(i))) found.add(i)
		}
	}
	if (!found.size) return `nothing to ${verb} in ${target.map((p) => p.text).join(' ')}`
	return numbered.filter((i) => found.has(i))
}

// What `mode` with `args` does in `items`, `fold` giving each block's
// state now: /toggle steps one named block (or the latest tool block);
// for more it expands all when more than half are collapsed, else
// collapses all (a tie expands: expanding hides nothing).
function plan(mode: Mode, items: Item[], args: string, fold: (item: Item) => Fold): Plan | string {
	let target = toggle.parse(args)
	if (typeof target === 'string') return target
	let found = toggle.resolve(items, target, mode)
	if (typeof found === 'string') return found
	if (mode !== 'toggle') return { items: found, open: mode === 'expand' }
	if (target.length <= 1 && (target[0]?.one ?? true)) return { items: found }
	let closed = found.filter((i) => fold(i) === 'closed').length
	return { items: found, open: closed * 2 >= found.length }
}

// '3 thinking blocks', 'tool block', '5 blocks'.
function noun(items: Item[]): string {
	let letters = new Set(items.map((i) => titles.letter(i)))
	let kind = letters.size === 1 ? `${kinds[[...letters][0]!]} ` : ''
	return items.length === 1 ? `${kind}block` : `${items.length} ${kind}blocks`
}

// The live hint: what Enter does ("Expands 12 tool blocks: t4-t88").
// `next` is a stepped block's next state.
function describe(p: Plan, next: (item: Item) => Fold): string {
	let state = p.open === undefined ? next(p.items[0]!) : p.open ? 'open' : 'closed'
	let verb = state === 'closed' ? 'Collapses' : state === 'inline' ? 'Shows pastes inline in' : 'Expands'
	let ids = p.items.map((i) => titles.blockId(i))
	return `${verb} ${toggle.noun(p.items)}${ids.length > 1 ? ':' : ''} ${ids.length > 6 ? `${ids[0]}-${ids.at(-1)}` : ids.join(', ')}`
}

// A block's state until toggled: tools closed (a glimpse), another
// session's message closed (its summary and glimpse), prompt-file
// changes closed (their summary rows), the rest open.
function initial(item: Item): Fold {
	return item.type === 'tool' || (item.type === 'output' && !!item.change) || (item.type === 'prompt' && !!item.summary) ? 'closed' : 'open'
}

// Whether a prompt has pastes, so it has three states.
function pastes(item: Item): string[] {
	if (item.type !== 'prompt') return []
	return attachments.markers(item.text).flatMap((m) => (m.kind === 'paste' && m.file ? [m.file] : []))
}

// The state after `now`: closed, open, then (with pastes) inline.
function next(item: Item, now: Fold): Fold {
	if (now === 'closed') return 'open'
	return now === 'open' && toggle.pastes(item).length ? 'inline' : 'closed'
}

// Applies `mode` with `args` to `states` (key → state). Returns the
// keys changed, or why none.
function apply(mode: Mode, states: Map<string, Fold>, items: Item[], args: string): string[] | string {
	let state = (i: Item) => states.get(i.key) ?? toggle.initial(i)
	let p = toggle.plan(mode, items, args, state)
	if (typeof p === 'string') return p
	for (let i of p.items) states.set(i.key, p.open === undefined ? toggle.next(i, state(i)) : !p.open ? 'closed' : state(i) === 'closed' ? 'open' : state(i))
	return p.items.map((i) => i.key)
}

export const toggle = { kinds, parse, toggles, resolve, plan, noun, describe, initial, pastes, next, apply }
