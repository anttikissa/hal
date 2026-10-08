// Session names use the ordinary command path; reminders are context only.
import type { HistoryRecord } from '../common/replay.ts'
import { names } from '../common/names.ts'
import { sessions } from './sessions.ts'
import { history } from './history.ts'
import { liveFiles } from './live-file.ts'
import { host } from './host.ts'
import { tabs } from './tabs.ts'

// Naming matters only when the user juggles tabs: interactive ones, 4 or more open.

function save(id: string): void {
	let meta = sessions.open(id)
	liveFiles.save(meta)
	host.broadcast(id, { type: 'meta', sessionId: id, meta: { ...meta } })
}
function manual(id: string, text?: string): void {
	let meta = sessions.open(id)
	meta.name = text === undefined ? names.fallback(id) : names.validate(text)
	delete meta.nameOwner
	if (text === undefined) {
		meta.nameTurns = 0
		meta.nameVersion = (meta.nameVersion ?? 0) + 1
	}
	naming.save(id)
}
function prepare(id: string, record: Extract<HistoryRecord, { type: 'user' }>): void {
	let text = record.blocks.slice(record.inbox?.length ?? 0).find((b) => b.type === 'text' && b.from === undefined && b.origin !== 'model' && b.text.trim())
	if (!text || text.type !== 'text') return
	let meta = sessions.open(id)
	if (meta.autoclose || tabs.file().open.length < 4) return
	// History commits the counter with the prompt; reconcile a crash before meta saved.
	let prior = history.readSync(id).findLast((r) => r.type === 'user' && r.naming?.version === (meta.nameVersion ?? 0))
	let turn = Math.max(meta.nameTurns ?? 0, prior?.type === 'user' ? prior.naming?.turn ?? 0 : 0) + 1
	record.naming = { turn, version: meta.nameVersion ?? 0, name: meta.name!, eligible: turn <= 3 || turn % 4 === 3 }
}
function committed(id: string, record: HistoryRecord): void {
	if (record.type !== 'user' || !record.naming) return
	sessions.open(id).nameTurns = record.naming.turn
	naming.save(id)
}
export const naming = { save, manual, prepare, committed }
