// Resolves a rewrite once; readers consume its result instead of replaying its plan.
import { basename } from 'path'
import { rebase, type RebasePlan } from '../common/rebase.ts'
import { replay, type HistoryRecord } from '../common/replay.ts'
import { generations } from './generations.ts'
import { history } from './history.ts'
import { pages } from './pages.ts'

type Rewrite = Extract<HistoryRecord, { type: 'rebase' }>

function latest(raw: HistoryRecord[]): Rewrite | undefined {
	let undone = new Set(raw.flatMap((r) => (r.type === 'rebase' && r.undo ? [r.undo] : [])))
	return raw.findLast(
		(r): r is Rewrite =>
			r.type === 'rebase' &&
			r.inactive === undefined &&
			!r.undo &&
			!undone.has(r.n!) &&
			!!(r.drop.length || r.edit.length),
	)
}

function project(id: string, raw: HistoryRecord[], plan: RebasePlan): { records: HistoryRecord[]; undo?: number } {
	if (!plan.drop.length && !plan.edit.length) {
		let last = rewriteHistory.latest(raw)
		if (last?.applied && last.replacesFile && last.base === plan.base) {
			let before = generations.read(id, last.replacesFile)
			// A migrated legacy marker was already present in its source file.
			if (before.some((r) => r.n === last.n && r.type === 'rebase'))
				before.push({ type: 'rebase', ...plan, ts: new Date().toISOString() })
			let restored = generations.resolved(before)
			let after = raw.slice(raw.findIndex((r) => r.n === last.n) + 1)
			return { records: [...restored, last, ...after], undo: last.n }
		}
	}
	return { records: rebase.apply(generations.resolved(raw), plan) }
}

function commit(id: string, raw: HistoryRecord[], records: HistoryRecord[], record: Rewrite): Rewrite {
	let old = basename(history.file(id)),
		size = pages.marks(id).size
	let active = new Set(replay.current(records).map((r) => r.n))
	let removed = new Set(pages.marks(id).dropped ?? [])
	for (let r of replay.current(raw)) if (!active.has(r.n)) removed.add(r.n!)
	for (let n of active) removed.delete(n!)
	let marker: Rewrite = { ...record, n: history.number(id), applied: true, replacesFile: old, removed: [...removed] }
	generations.start(id, [...records, marker], { reason: marker.undo ? 'undo' : 'rebase', replaces: old }, size)
	for (let listener of history.state.listeners) listener(id, marker)
	return marker
}

// Writes a history whose old rebases or edits readers still replay as a
// resolved generation (scripts/migrate-histories). The latest rewrite
// keeps its source file, so /rebase undo still reverses it. False when
// nothing needs resolving.
function migrate(id: string): boolean {
	let raw = history.readSync(id)
	if (!raw.some((r) => (r.type === 'rebase' && !r.applied) || (r.type === 'user' && r.replaces))) return false
	let old = basename(history.file(id))
	let records = generations.resolved(raw)
	let last = rewriteHistory.latest(records)
	if (last && !last.replacesFile) last.replacesFile = old
	generations.start(id, records, { reason: 'migrate', replaces: old }, pages.marks(id).size)
	return true
}

export const rewriteHistory = { latest, project, commit, migrate }
