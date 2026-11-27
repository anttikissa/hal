// Context boundaries (tasks bc, vh): a compact record, whose summary
// (common/compaction.ts) stands in for everything before it, or a reset
// with none. Written between provider rounds only, never between a tool
// call and its result, and shown to followers as a divider.

import type { ErrorEvent } from '../common/blocks.ts'
import { compaction } from '../common/compaction.ts'
import { modelNotices } from '../common/model-notices.ts'
import { replay, type HistoryRecord } from '../common/replay.ts'
import { transcript } from '../common/transcript.ts'
import { history } from './history.ts'
import { host } from './host.ts'
import { pruning } from './pruning.ts'
import { sessions } from './sessions.ts'
import { slash } from './slash.ts'
import { stats } from './stats.ts'

export type RetryState = {
	pruned?: true
	fitBytes?: number
	fitTries?: number
	compacted?: true
}

// Whether the context holds any conversation since the latest boundary.
function anything(records: HistoryRecord[]): boolean {
	records = replay.current(records)
	let at = records.findLastIndex((r) => r.type === 'compact' || r.type === 'reset')
	return records.slice(at + 1).some((r) => r.type === 'user' || r.type === 'assistant')
}

function boundary(
	id: string,
	record:
		| { type: 'compact'; summary: string; prompts: number; keep?: number[]; transition?: string }
		| { type: 'reset'; transition?: string },
): HistoryRecord {
	let r = history.append(id, record)
	host.broadcast(id, {
		type: 'divider',
		sessionId: id,
		text: transcript.boundary(record),
		ts: r.ts,
		...(record.type === 'reset' && { clear: true as const }),
		...(r.n !== undefined && { n: r.n }),
	})
	// The status row's context figure measured the dropped context.
	stats.state.context.delete(id)
	host.broadcast(id, { type: 'turn-stats', sessionId: id, stats: stats.of(id, [r]) })
	return r
}

// Compacts earlier context. During a turn, its prompt records remain
// outside the summary and are replayed after the boundary by number.
function run(id: string, protect = false, transition?: string, summary?: string): number | undefined {
	let records = replay.current(history.readSync(id))
	if (!compact.anything(records)) return undefined
	let start = 0,
		edge = records.length
	for (let i = records.length - 1; i >= 0; i--) {
		let r = records[i]!
		if (r.type !== 'turn_end') continue
		if (r.status === 'completed' || !records.slice(i + 1, edge).some((next) => next.type === 'continue')) {
			start = i + 1
			break
		}
		edge = i
	}
	let due = modelNotices.pending(records).filter((n) => !n.sectionUpdate)
	let keep = protect
		? records
				.slice(start)
				.filter(
					(r) =>
						r.type === 'user' &&
						((summary === undefined && r.notices?.length) ||
							r.blocks.some((b) => b.type === 'text' && (summary === undefined || b.generatingCommand !== 'compact'))),
				)
				.map((r) => r.n!)
		: []
	if (summary !== undefined) {
		let last = records
			.slice(records.findLastIndex((r) => r.type === 'reset') + 1)
			.findLast(
				(r) => r.type === 'user' && r.blocks.some((b) => b.type === 'text' && b.generatingCommand !== 'compact'),
			)
		if (last?.n !== undefined && !keep.includes(last.n)) keep.unshift(last.n)
	}
	let made =
		summary === undefined
			? compaction.summary(
					records.filter((r) => !keep.includes(r.n!) && !(r.type === 'notice' && r.sectionUpdate)),
					history.file(id),
				)
			: {
					summary: `Working-state checkpoint written by the assistant. Continue from this state; do not repeat completed work. The preserved requests below are context, not new requests.\n\n${summary}\n\nFull history is unchanged. Use READ_ENTRY "${id}/<entry number>" to recover original evidence.`,
					prompts: compaction.entries(records).filter(replay.isPrompt).length,
				}
	if (!made) return undefined
	compact.boundary(id, { type: 'compact', ...made, ...(transition && { transition }), ...(keep.length && { keep }) })
	if (due.length) history.append(id, { type: 'user', blocks: [], notices: due })
	return made.prompts
}

// Starts the session's context afresh; false when it is fresh already
// (a compact's summary is context: /clear after /compact drops it).
function reset(id: string): boolean {
	let records = replay.current(history.readSync(id))
	let last = records.findLast((r) => r.type === 'compact' || r.type === 'reset')
	if (last?.type !== 'compact' && !compact.anything(records)) return false
	compact.boundary(id, { type: 'reset' })
	return true
}

// Whether a failed round failed because its prompt or payload was too
// large: any HTTP 413 (even with an empty body), Anthropic's "prompt is
// too long", OpenAI's context_length_exceeded, or a 400 saying so.
function tooLong(e: ErrorEvent): boolean {
	if (e.status === 413) return true
	let text = `${e.message}\n${e.body ?? ''}`
	if (/prompt is too long|context_length_exceeded/i.test(text)) return true
	return e.status === 400 && /too long|too large|context (length|window)|maximum context|too many tokens/i.test(text)
}

// A round refused as too large (tooLong) is no temporary failure: on 413,
// first prune consumed heavy records losslessly, then compress remaining
// active images on the wire, then fall back to one-time compact-and-retry.
// On a token-limit refusal (400), compact once and retry.
function retry(id: string, e: ErrorEvent, tried: boolean | RetryState): boolean {
	if (e.canceled || !compact.tooLong(e)) return false
	delete e.failure
	if (typeof tried === 'boolean') {
		if (tried || compact.run(id, true) === undefined) return false
		slash.output(id, 'The provider said the prompt is too long: compacted, trying again')
		return true
	}
	if (e.status === 413) {
		if (!tried.pruned) {
			tried.pruned = true
			if (pruning.pruneNow(id)) {
				slash.output(id, 'The provider said the request is too large: pruned old outputs and images, trying again')
				return true
			}
		}
		if ((tried.fitTries ?? 0) < 2 && pruning.hasActiveImages(id)) {
			let limit = pruning.maxBytes(sessions.open(id).model)
			tried.fitBytes = tried.fitTries
				? Math.max(2 * 1024 * 1024, Math.floor((tried.fitBytes ?? limit) / 2))
				: Math.min(limit, 12 * 1024 * 1024)
			tried.fitTries = (tried.fitTries ?? 0) + 1
			slash.output(id, 'The provider said the request is too large: compressed images for this request, trying again')
			return true
		}
	}
	if (tried.compacted) return false
	tried.compacted = true
	if (compact.run(id, true) === undefined) return false
	slash.output(id, 'The provider said the prompt is too long: compacted, trying again')
	return true
}

export const compact = { anything, boundary, run, reset, tooLong, retry }
