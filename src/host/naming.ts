// Names sessions so the user can tell tabs apart. Names change through
// the ordinary command path; naming reminders reach the model as context
// only.
import type { HistoryRecord } from '../common/replay.ts'
import { names } from '../common/names.ts'
import { sessions } from './sessions.ts'
import { history } from './history.ts'
import { tabs } from './tabs.ts'

// Naming matters only when the user juggles tabs: interactive ones, 4 or more open.

function manual(id: string, text?: string): void {
	sessions.update(id, {
		name: text === undefined ? names.fallback(id) : names.validate(text),
		nameOwner: undefined,
		...(text === undefined && { nameTurns: 0, nameVersion: (sessions.open(id).nameVersion ?? 0) + 1 }),
	})
}
function prepare(id: string, record: Extract<HistoryRecord, { type: 'user' }>): void {
	let text = record.blocks
		.slice(record.inbox?.length ?? 0)
		.find((b) => b.type === 'text' && b.from === undefined && b.origin !== 'model' && b.text.trim())
	if (!text || text.type !== 'text') return
	let meta = sessions.open(id)
	if (meta.autoclose || tabs.file().open.length < 4) return
	// History commits the counter with the prompt; reconcile a crash before meta saved.
	let prior = history.readSync(id).findLast((r) => r.type === 'user' && r.naming?.version === (meta.nameVersion ?? 0))
	let turn = Math.max(meta.nameTurns ?? 0, prior?.type === 'user' ? (prior.naming?.turn ?? 0) : 0) + 1
	record.naming = { turn, version: meta.nameVersion ?? 0, name: meta.name!, eligible: turn <= 3 || turn % 4 === 3 }
}
function committed(id: string, record: HistoryRecord): void {
	if (record.type !== 'user' || !record.naming) return
	sessions.update(id, { nameTurns: record.naming.turn })
}
export const naming = { manual, prepare, committed }
