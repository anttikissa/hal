// Lets Anthropic find its cached prefix again after another model ran
// (task g5j), by marking where a model's earlier provider input ended.

import type { Message } from './blocks.ts'
import { replay, type HistoryRecord } from './replay.ts'

// Back on a model after another one ran (task g5j). Anthropic finds a
// cached prefix only within 20 positions back from a cache marker. With
// one model that is enough: each round caches its own input, a few
// blocks behind the next. Another model's tool exchange can add more, so
// the newest marker no longer reaches the old cache and it is written
// again in full (session 08-nah: ~13k tokens). Marking where this
// model's last input ended finds it; Anthropic checks the prefix still
// matches (pruning or an edit can change it), so nothing is stored.
// Returns `messages`.
function markCache(records: HistoryRecord[], messages: Message[], model?: string): Message[] {
	let rounds = records.filter((r) => r.type === 'round')
	if (!model || !rounds.length || rounds.at(-1)!.model === model) return messages
	let mine = rounds.findLast((r) => r.model === model && r.block !== undefined)
	let start = records.findLastIndex((r) => r.type === 'compact' || r.type === 'reset')
	if (!mine || records.indexOf(mine) < start) return messages
	let count = replay
		.toMessages(records.filter((r) => r.n === undefined || r.n < mine.block!))
		.reduce((sum, m) => sum + m.blocks.length, 0)
	for (let m of messages) {
		if (count <= m.blocks.length) {
			if (count) m.cache = count
			break
		}
		count -= m.blocks.length
	}
	return messages
}

export const cacheMarker = { markCache }
