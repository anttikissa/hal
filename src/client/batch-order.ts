// The order the terminal draws a transcript's tool batches in
// (frame.layout).

import type { Item } from '../common/transcript.ts'

// Display order. Only the bottom block grows (task 5gn). A parallel
// batch first seen with a result missing is `split`: each call stays
// its title and command, marked ↓ (`apart`); the results come after the
// batch's calls, each linking to its call, then one `live` block: the
// running output of the last call that has some. Streaming and
// finishing never change rows above them. Every other batch shows each
// result right under its call, as web cards do. A canonical rebuild
// forgets the splits and puts the results already there (`joined`)
// under their calls; later
// output stays apart until another rebuild. A single call keeps its
// output and result under it. With a `deadline`, stops after the first
// batch once it is past; passing the returned `at` back goes on from
// there (task 7j).
function order(items: Item[]): Item[]
function order(items: Item[], deadline: number, at?: Ordering): Ordering
function order(items: Item[], deadline?: number, at: Ordering = { i: 0, out: [] }): Item[] | Ordering {
	let { out } = at, i = at.i
	let { split, joined, apart } = batchOrder.state
	for (let first = true; i < items.length; first = false) {
		if (!first && deadline !== undefined && performance.now() > deadline) break
		let j = i
		// One round's calls are consecutive records; a gap starts another batch.
		let next = (a: Item, b: Item) => !/^\d+$/.test(a.key) || !/^\d+$/.test(b.key) || Number(b.key) === Number(a.key) + 1
		while (j < items.length && items[j]!.type === 'tool' && (j === i || next(items[j - 1]!, items[j]!))) j++
		let k = j
		while (k < items.length && items[k]!.type === 'tool-result') k++
		let calls = items.slice(i, j) as (Item & { type: 'tool' })[]
		let results = items.slice(j, k) as (Item & { type: 'tool-result' })[]
		let own = (c: Item & { type: 'tool' }) => results.filter((r) => r.id === c.id)
		if (calls.length > 1 && calls.some((c) => !own(c).length)) split.add(calls[0]!.id)
		if (calls.length < 2 || !split.has(calls[0]!.id)) {
			if (calls.length < 2) out.push(...items.slice(i, Math.max(k, i + 1)))
			else {
				for (let c of calls) out.push(c, ...own(c))
				out.push(...results.filter((r) => !calls.some((c) => c.id === r.id)))
			}
		} else {
			let together = (c: Item & { type: 'tool' }) => own(c).length > 0 && own(c).every((r) => joined.has(r))
			let live: Item[] = []
			for (let c of calls) {
				if (together(c)) {
					out.push(c, ...own(c))
					continue
				}
				let short = { ...c, partial: undefined }
				apart.add(short)
				out.push(short)
				if (c.partial && !own(c).length) live = [{ type: 'tool-result', id: c.id, output: c.partial, key: `${c.key}~live`, ts: c.ts, live: true } as Item]
			}
			let below = [...results.filter((r) => !calls.some((c) => c.id === r.id && together(c))), ...live]
			for (let r of below) batchOrder.state.below.set(r, calls[0]!.key)
			out.push(...below)
		}
		i = Math.max(k, i + 1)
	}
	return deadline === undefined ? out : { i, out }
}

export type Ordering = { i: number; out: Item[] }

// `below`: the blocks after a split batch's calls, by the batch's first
// call; together they never shrink (frame.layout).
export const batchOrder = { state: { split: new Set<string>(), joined: new WeakSet<Item>(), apart: new WeakSet<Item>(), below: new WeakMap<Item, string>() }, order }
