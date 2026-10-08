// What a client opening a session gets (protocol Snapshot): the tail
// of its history (pages.snapshot, or one read in slices and caught up
// with pages.since) and its live state now.

import { rebaseDisplay } from '../common/rebase-display.ts'
import { replay } from '../common/replay.ts'
import type { Snapshot } from '../common/protocol.ts'
import { diag } from './diag.ts'
import { drafts } from './drafts.ts'
import { history } from './history.ts'
import { pages, type Tail } from './pages.ts'
import { sessions } from './sessions.ts'
import { stats } from './stats.ts'
import { status } from './status.ts'
import { toolOutput } from './tool-output.ts'
import { queueEdits } from './queue-edits.ts'
import { turns } from './turns.ts'

function build(id: string, tail: Tail = pages.snapshot(id)): Snapshot {
	let records = [...tail.earlier, ...tail.history]
	let snap: Snapshot = { meta: { ...sessions.open(id) }, history: tail.history, state: status.stateOf(id, records), inbox: status.inboxOf(id, records), stats: stats.of(id, records) }
	if (pages.marks(id).rebase !== undefined) {
		let raw = history.readSync(id)
		snap.rewrites = rebaseDisplay.dividers(raw)
		let kept = new Set(replay.current(raw).map((r) => r.n))
		snap.dropped = replay.current(raw.filter((r) => r.type !== 'rebase')).flatMap((r) => r.n !== undefined && !kept.has(r.n) ? [r.n] : [])
	}
	let hold = queueEdits.state.get(id)
	if (hold) snap.queueHold = hold.message
	let outputs = toolOutput.of(id)
	if (outputs.length) snap.toolOutput = outputs.map((p) => ({ ...p }))
	if (tail.older !== undefined) Object.assign(snap, { older: tail.older, earlier: tail.earlier })
	try {
		let draft = drafts.get(id)
		if (draft.rev) snap.draft = draft
	} catch (e: any) {
		// A malformed draft.ason stays on disk untouched; the session opens.
		diag.log(`draft ${id}: ${e?.message ?? e}`)
	}
	let running = turns.state.running.get(id)
	if (running) {
		let live = history.live(id)
		snap.turn = { provider: running.provider, blocks: live?.blocks ?? [], usage: live?.usage ?? {}, ns: live?.ns ?? [], ts: live?.ts ?? [] }
		if (running.model !== undefined) snap.turn.model = running.model
		if (running.effort !== undefined) snap.turn.effort = running.effort
	}
	return snap
}

export const snapshots = { build }
