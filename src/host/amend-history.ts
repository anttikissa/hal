// Prompt edits keep their old records inactive in the rewritten tail, for undo.
import { replay, type HistoryRecord } from '../common/replay.ts'
import { states } from '../common/states.ts'
import { forms } from '../common/forms.ts'
import { history } from './history.ts'
import { historyTail } from './history-tail.ts'
import { naming } from './naming.ts'
import { pages } from './pages.ts'
import { prompts } from './prompts.ts'
import { rebasePlans } from './rebase-plans.ts'

type Tail = ReturnType<typeof historyTail.read>
type Prompt = Extract<HistoryRecord, { type: 'user' }>

function apply(id: string, tail: Tail, replacement: Omit<Prompt, 'ts'>): Prompt {
	let n = history.number(id),
		ts = new Date().toISOString()
	let drop = tail.records.filter((r) => r.inactive === undefined && r.type !== 'rebase' && !rebasePlans.survives(r))
	let gone = new Set(drop.map((r) => r.n))
	let marker: HistoryRecord = {
		type: 'rebase',
		applied: true,
		quiet: true,
		n,
		ts,
		base: tail.records.at(-1)?.n ?? 0,
		drop: drop.map((r) => r.n!),
		edit: [],
	}
	let record = { ...replacement, n: history.number(id), ts } as Prompt
	naming.prepare(id, record)
	historyTail.write(id, tail.offset, [
		...tail.records.map((r) => (gone.has(r.n) ? { ...r, inactive: n } : r)),
		marker,
		record,
	])
	naming.committed(id, record)
	for (let listener of history.state.listeners) listener(id, marker)
	return record
}

function undo(id: string): string {
	if (forms.open(pages.essentials(id))) throw new Error('Answer or dismiss the open question before undoing the edit.')
	let last = pages.findLast(id, (r) => r.type === 'rebase')
	if (last?.type !== 'rebase' || !last.applied || !last.quiet || last.undo)
		throw new Error('Nothing to undo: the latest history rewrite is not an edit.')
	let saved = pages.marks(id).beforeAmend
	let tail =
		saved && saved.n === last.n
			? {
					offset: saved.offset,
					records: pages
						.lines(
							history.file(id),
							pages.readBytes(history.file(id), saved.offset, pages.marks(id).size),
							saved.offset,
						)
						.map((l) => l.record),
				}
			: historyTail.read(id, last.drop[0])
	let after = tail.records.slice(tail.records.findIndex((r) => r.n === last.n) + 1)
	if (!prompts.harmless(after.filter((r) => r.inactive === undefined)))
		throw new Error('Cannot undo the edit: tools with side effects ran after it.')
	let n = history.number(id),
		ts = new Date().toISOString()
	let records = tail.records.map((r) => {
		if (r.inactive === last.n) {
			let { inactive: _, ...active } = r
			return active as HistoryRecord
		}
		if (
			r.inactive === undefined &&
			(r.n === last.n || after.includes(r)) &&
			!rebasePlans.survives(r) &&
			!(r.type === 'command' && r.text.trim() === '/edit undo')
		)
			return { ...r, inactive: n }
		return r
	})
	records.push({ type: 'rebase', applied: true, quiet: true, base: last.base, drop: [], edit: [], undo: last.n, n, ts })
	if (states.fromHistory(replay.current(records)).type !== 'paused')
		records.push({ type: 'turn_end', status: 'paused', usage: {}, n: history.number(id), ts })
	historyTail.write(id, tail.offset, records)
	rebasePlans.broadcast(id, Math.min(...last.drop))
	return `Edit undone: prompt u${last.drop[0]} and its partial output are back.`
}

export const amendHistory = { apply, undo }
