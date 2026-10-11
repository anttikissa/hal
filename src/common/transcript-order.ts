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
	let previous = new Map(items.slice(start).map((item) => [item.key, item]))
	let next = [...items.slice(0, start), ...transcriptOrder.order([...items.slice(start).filter((item) => !keys.has(item.key)), ...after.map((item) => {
		let old = previous.get(item.key)
		return old && Object.keys(old).length === Object.keys(item).length && Object.entries(item).every(([key, value]) => Reflect.get(old, key) === value) ? old : item
	})])]
	return next.length === items.length && next.every((item, i) => item === items[i]) ? items : next
}

export const transcriptOrder = { order, replace }
