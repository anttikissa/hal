// Opening and closing transcript blocks (tasks ghs, r4d): which blocks
// a /toggle target names, and the states a block steps through. Pure;
// each client keeps its blocks' states in memory, never stored or
// synced.

import { attachments } from './attachments.ts'
import type { Item } from './transcript.ts'

// `inline`: a prompt open with its pastes' text in place of markers.
export type Fold = 'closed' | 'open' | 'inline'
// A block number or an inclusive range of them; `latest`: no target,
// the latest tool block.
export type Target = { from: number; to: number; range: boolean } | { latest: true }

const USAGE = 'usage: /toggle [#t24 | 24 | 10-24]'

// "#t24", "t24", "#24", "24", "10-24": a block's kind letter is
// ignored, its number alone is unique (a history line).
function parse(args: string): Target | string {
	let t = args.trim()
	if (!t) return { latest: true }
	let m = /^#?[a-z]?(\d+)(?:\s*-\s*#?[a-z]?(\d+))?$/i.exec(t)
	if (!m) return USAGE
	let a = Number(m[1]), b = m[2] === undefined ? a : Number(m[2])
	return { from: Math.min(a, b), to: Math.max(a, b), range: m[2] !== undefined }
}

// Whether `item` opens and closes; `range`: as part of a range, which
// leaves assistant text and the user's prompts alone.
function toggles(item: Item, range = false): boolean {
	if (item.type === 'tool' || item.type === 'thinking' || (item.type === 'output' && !!item.change)) return true
	if (item.type === 'text') return !range
	return item.type === 'prompt' && (!range || item.from !== undefined)
}

// The keys of the blocks `target` names in `items`, or why none.
function keys(items: Item[], target: Target): string[] | string {
	if ('latest' in target) {
		let tool = items.findLast((i) => i.type === 'tool')
		return tool ? [tool.key] : 'no tool block to toggle'
	}
	let found = items.filter((i) => {
		if (!/^\d+$/.test(i.key)) return false
		let n = Number(i.key)
		return n >= target.from && n <= target.to && toggle.toggles(i, target.range)
	})
	if (found.length) return found.map((i) => i.key)
	if (!target.range && items.some((i) => i.key === String(target.from))) return `block ${target.from} does not open or close`
	return target.range ? `nothing to toggle in ${target.from}-${target.to}` : `no block ${target.from} to toggle`
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

// Flips the blocks `target` names in `states` (key → state): every
// one steps on. Returns the keys flipped, or why none.
function flip(states: Map<string, Fold>, items: Item[], target: Target): string[] | string {
	let found = toggle.keys(items, target)
	if (typeof found === 'string') return found
	for (let key of found) {
		let item = items.find((i) => i.key === key)!
		states.set(key, toggle.next(item, states.get(key) ?? toggle.initial(item)))
	}
	return found
}

export const toggle = { USAGE, parse, toggles, keys, initial, pastes, next, flip }
