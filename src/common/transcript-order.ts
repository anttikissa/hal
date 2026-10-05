// Blocks reserve their number when they start, not when their stream ends.
// Use that order in both clients; keep synthetic/un-numbered items in place.
import type { Item } from './transcript.ts'

function order(items: Item[]): Item[] {
	return items.toSorted((a, b) => {
		let x = Number(a.key), y = Number(b.key)
		return Number.isFinite(x) && Number.isFinite(y) ? x - y : 0
	})
}

function replace(items: Item[], start: number, before: Item[], after: Item[]): Item[] {
	let keys = new Set(before.map((item) => item.key))
	return [...items.slice(0, start), ...transcriptOrder.order([...items.slice(start).filter((item) => !keys.has(item.key)), ...after])]
}

export const transcriptOrder = { order, replace }
