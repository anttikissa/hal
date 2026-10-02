// Validate durable conversation records; corruption fails loudly.
import { ason } from '../common/ason.ts'
import { sender } from '../common/sender.ts'
import type { HistoryRecord } from '../common/replay.ts'

const recordTypes = new Set(['user', 'assistant', 'turn_end', 'continue', 'inbox', 'question', 'answer', 'command', 'output', 'change', 'compact', 'reset', 'file_changes', 'round'])

function check(value: unknown): HistoryRecord {
	let r = value as HistoryRecord
	if (!r || typeof r !== 'object' || !recordTypes.has(r.type) || (r.n !== undefined && !Number.isSafeInteger(r.n))) throw new Error(`unknown record ${ason.stringify(value, 'short').slice(0, 80)}`)
	if (r.originSession !== undefined && (typeof r.originSession !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(r.originSession))) throw new Error('invalid origin session')
	if ((r.type === 'command' || r.type === 'output') && r.origin !== undefined && r.origin !== 'model') throw new Error(`invalid ${r.type} origin`)
	let senders = r.type === 'user' ? r.blocks.filter((b) => b.type === 'text') : r.type === 'inbox' || r.type === 'command' ? [r] : []
	for (let s of senders) { let problem = sender.invalid(s); if (problem) throw new Error(problem) }
	if (r.type === 'output' && r.transition !== undefined) {
		let t = r.transition
		if (!t || typeof t.id !== 'string' || !['clear', 'compact'].includes(t.kind) || (t.prompt !== undefined && typeof t.prompt !== 'string') || (t.cancelled !== undefined && t.cancelled !== true) || sender.invalid(t.sender)) throw new Error('invalid context transition')
	}
	if (r.type === 'output' && r.synthetic !== undefined && r.synthetic !== true) throw new Error('invalid synthetic output')
	if (r.type === 'output') for (let k of ['transitionDone', 'transitionCancel'] as const) if (r[k] !== undefined && typeof r[k] !== 'string') throw new Error(`invalid ${k}`)
	if ((r.type === 'reset' || r.type === 'compact') && r.transition !== undefined && typeof r.transition !== 'string') throw new Error('invalid boundary transition')
	if (r.type === 'user' && r.naming !== undefined) {
		let n = r.naming
		if (!n || !Number.isSafeInteger(n.turn) || n.turn < 1 || !Number.isSafeInteger(n.version) || n.version < 0 || typeof n.name !== 'string' || typeof n.eligible !== 'boolean') throw new Error('invalid naming context')
	}
	return r
}
export const historyCheck = { check }
