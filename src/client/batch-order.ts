// The order the terminal draws a transcript's tool batches in
// (frame.layout).

import type { Item } from '../common/transcript.ts'

// Display order: parallel calls each with their results right under
// them, as web cards are; unless the batch as drawn (`fits` measures
// its rows) is taller than a screen: then calls and results stay
// separate blocks, each result linking to its call, so finishing calls
// never rewrite scrollback. A split batch stays split between canonical
// rebuilds, which reunite the results already available. Later output
// stays separate until another rebuild.
// With a `deadline`, stops after the first batch once it is past;
// passing the returned `at` back goes on from there (task 7j): `fits`
// lays out every multi-call batch, so a long history is ordered in
// slices.
function order(items: Item[], fits: (batch: Item[]) => boolean): Item[]
function order(items: Item[], fits: (batch: Item[]) => boolean, deadline: number, at?: Ordering): Ordering
function order(items: Item[], fits: (batch: Item[]) => boolean, deadline?: number, at: Ordering = { i: 0, out: [] }): Item[] | Ordering {
	let { out } = at, i = at.i
	for (let first = true; i < items.length; first = false) {
		if (!first && deadline !== undefined && performance.now() > deadline) break
		let j = i
		while (j < items.length && items[j]!.type === 'tool') j++
		let k = j
		while (k < items.length && items[k]!.type === 'tool-result') k++
		let calls = items.slice(i, j) as (Item & { type: 'tool' })[]
		let results = items.slice(j, k) as (Item & { type: 'tool-result' })[]
		let split = calls.length > 1 && batchOrder.state.split.has(calls[0]!.id)
		if (calls.length > 1 && !split && !fits(items.slice(i, k))) {
			batchOrder.state.split.add(calls[0]!.id)
			split = true
		}
		if (calls.length < 2) out.push(...items.slice(i, Math.max(k, i + 1)))
		else {
			let attached = (r: Item) => !split || batchOrder.state.joined.has(r)
			for (let c of calls) out.push(c, ...results.filter((r) => r.id === c.id && attached(r)))
			out.push(...results.filter((r) => !attached(r) || !calls.some((c) => c.id === r.id)))
		}
		i = Math.max(k, i + 1)
	}
	return deadline === undefined ? out : { i, out }
}

export type Ordering = { i: number; out: Item[] }

export const batchOrder = { state: { split: new Set<string>(), joined: new WeakSet<Item>() }, order }
