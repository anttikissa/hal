// Context boundaries (tasks bc, vh): a compact record, whose summary
// (common/compaction.ts) stands in for everything before it, or a reset
// with none. Written between provider rounds only, never between a tool
// call and its result, and shown to followers as a divider.

import { compaction } from '../common/compaction.ts'
import type { HistoryRecord } from '../common/replay.ts'
import { transcript } from '../common/transcript.ts'
import { history } from './history.ts'
import { host } from './host.ts'

// Whether the context holds any conversation since the latest boundary.
function anything(records: HistoryRecord[]): boolean {
	let at = records.findLastIndex((r) => r.type === 'compact' || r.type === 'reset')
	return records.slice(at + 1).some((r) => r.type === 'user' || r.type === 'assistant')
}

function boundary(id: string, record: { type: 'compact'; summary: string; prompts: number } | { type: 'reset' }): HistoryRecord {
	let r = history.append(id, record)
	host.broadcast(id, { type: 'divider', sessionId: id, text: transcript.boundary(record), ...(r.n !== undefined && { n: r.n }) })
	return r
}

// Compacts the session's context; how many prompts the summary covers,
// or undefined when there is nothing to compact.
function run(id: string): number | undefined {
	let records = history.readSync(id)
	if (!compact.anything(records)) return undefined
	let made = compaction.summary(records, history.file(id))
	if (!made) return undefined
	compact.boundary(id, { type: 'compact', ...made })
	return made.prompts
}

// Starts the session's context afresh; false when it is fresh already.
function reset(id: string): boolean {
	if (!compact.anything(history.readSync(id))) return false
	compact.boundary(id, { type: 'reset' })
	return true
}

export const compact = { anything, boundary, run, reset }
