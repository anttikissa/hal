// The order the terminal draws a transcript's tool batches in
// (frame.layout).

import type { Item } from '../common/transcript.ts'

// Display order: parallel calls each with their results right under
// them, as web cards are; unless the batch as drawn (`fits` measures
// its rows) is taller than a screen: then calls and results stay
// separate blocks, each result linking to its call, so finishing calls
// never rewrite scrollback. A batch that once overflowed stays split,
// so its layout never flips back. Later items keep their place
// (background output arrives as its own block).
function order(items: Item[], fits: (batch: Item[]) => boolean): Item[] {
	let out: Item[] = []
	for (let i = 0; i < items.length; ) {
		let j = i
		while (j < items.length && items[j]!.type === 'tool') j++
		let k = j
		while (k < items.length && items[k]!.type === 'tool-result') k++
		let calls = items.slice(i, j) as (Item & { type: 'tool' })[]
		let results = items.slice(j, k) as (Item & { type: 'tool-result' })[]
		let split = calls.length > 1 && batchOrder.state.split.has(calls[0]!.key)
		if (calls.length > 1 && !split && !fits(items.slice(i, k))) {
			batchOrder.state.split.add(calls[0]!.key)
			split = true
		}
		if (calls.length < 2 || split) out.push(...items.slice(i, Math.max(k, i + 1)))
		else {
			for (let c of calls) out.push(c, ...results.filter((r) => r.id === c.id))
			out.push(...results.filter((r) => !calls.some((c) => c.id === r.id)))
		}
		i = Math.max(k, i + 1)
	}
	return out
}

export const batchOrder = { state: { split: new Set<string>() }, order }
