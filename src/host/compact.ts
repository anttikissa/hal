// Context boundaries (tasks bc, vh): a compact record, whose summary
// (common/compaction.ts) stands in for everything before it, or a reset
// with none. Written between provider rounds only, never between a tool
// call and its result, and shown to followers as a divider.

import type { ErrorEvent, Usage } from '../common/blocks.ts'
import { compaction } from '../common/compaction.ts'
import type { HistoryRecord } from '../common/replay.ts'
import { settings } from '../common/settings.ts'
import { transcript } from '../common/transcript.ts'
import { history } from './history.ts'
import { host } from './host.ts'
import { models } from './models.ts'
import { slash } from './slash.ts'

// Whether the context holds any conversation since the latest boundary.
function anything(records: HistoryRecord[]): boolean {
	let at = records.findLastIndex((r) => r.type === 'compact' || r.type === 'reset')
	return records.slice(at + 1).some((r) => r.type === 'user' || r.type === 'assistant')
}

function boundary(id: string, record: { type: 'compact'; summary: string; prompts: number; keep?: number[] } | { type: 'reset' }): HistoryRecord {
	let r = history.append(id, record)
	history.forget(id)
	host.broadcast(id, { type: 'divider', sessionId: id, text: transcript.boundary(record), ...(r.n !== undefined && { n: r.n }) })
	return r
}

// Compacts earlier context. During a turn, its prompt records remain
// outside the summary and are replayed after the boundary by number.
function run(id: string, protect = false): number | undefined {
	let records = history.readSync(id)
	if (!compact.anything(records)) return undefined
	let start = records.findLastIndex((r) => r.type === 'turn_end') + 1
	let keep = protect ? records.slice(start).filter((r) => r.type === 'user' && r.blocks.some((b) => b.type === 'text')).map((r) => r.n!) : []
	let made = compaction.summary(records.filter((r) => !keep.includes(r.n!)), history.file(id))
	if (!made) return undefined
	compact.boundary(id, { type: 'compact', ...made, ...(keep.length && { keep }) })
	return made.prompts
}

// Starts the session's context afresh; false when it is fresh already
// (a compact's summary is context: /clear after /compact drops it).
function reset(id: string): boolean {
	let records = history.readSync(id)
	let last = records.findLast((r) => r.type === 'compact' || r.type === 'reset')
	if (last?.type !== 'compact' && !compact.anything(records)) return false
	compact.boundary(id, { type: 'reset' })
	return true
}

const taken = (u: Usage) => (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0)

// What the session's last provider round took in (task 1g's context):
// the running turn's latest round, else the last turn end that says;
// unknown once a boundary follows it.
function used(id: string): number | undefined {
	let running = history.state.running.get(id)
	let now = running && (taken(running.turn.usage) || running.context)
	if (now) return now
	let records = history.readSync(id)
	for (let i = records.length - 1; i >= 0; i--) {
		let r = records[i]!
		if (r.type === 'compact' || r.type === 'reset') return undefined
		if (r.type === 'turn_end' && r.context) return r.context
	}
	return undefined
}

// Before a provider round (task mq): compacts when the last round
// filled at least settings.compactAt() of `model`'s window, and says so.
// Called only between rounds, after results are recorded.
function auto(id: string, model: string): void {
	let at = settings.compactAt()
	let window = models.contextWindow(model)
	let context = compact.used(id)
	if (!at || !window || !context || context < at * window) return
	if (compact.run(id, true) === undefined) return
	slash.output(id, `context ${Math.round((context / window) * 100)}% full (${context} of ${window} tokens): compacted`)
}

// Whether a failed round failed because its prompt was too long for the
// model: Anthropic's "prompt is too long", OpenAI's
// context_length_exceeded, or a 400/413 whose message says so.
function tooLong(e: ErrorEvent): boolean {
	let text = `${e.message}\n${e.body ?? ''}`
	if (/prompt is too long|context_length_exceeded/i.test(text)) return true
	return (e.status === 400 || e.status === 413) && /too long|too large|context (length|window)|maximum context|too many tokens/i.test(text)
}

// A round refused as too long (tooLong) is no temporary failure: the
// first time in a turn (`tried` false) the context is compacted and
// true says to retry the round; after that the turn fails with it.
function retry(id: string, e: ErrorEvent, tried: boolean): boolean {
	if (e.cancelled || !compact.tooLong(e)) return false
	delete e.failure
	if (tried || compact.run(id, true) === undefined) return false
	slash.output(id, 'the provider said the prompt is too long: compacted, trying again')
	return true
}

export const compact = { anything, boundary, run, reset, used, auto, tooLong, retry }
