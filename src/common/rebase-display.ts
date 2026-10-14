// Rebase controls are display-only; provider replay still excludes them.
import { rebase } from './rebase.ts'
import { rebaseRows } from './rebase-rows.ts'
import type { Item } from './transcript.ts'
import { replay, type HistoryRecord } from './replay.ts'

function current(raw: HistoryRecord[]): HistoryRecord[] {
	let projected = replay.current(raw), active = new Set(projected), byNumber = new Map(projected.filter((r) => r.n !== undefined).map((r) => [r.n, r]))
	let candidates: HistoryRecord[] = raw.filter((r) => r.type !== 'rebase')
	for (let r of rebase.latest(raw)) if (r.type === 'rebase') candidates = rebase.apply(candidates, r)
	return [...candidates.flatMap((r) => active.has(r) ? [r] : byNumber.has(r.n) ? [byNumber.get(r.n)!] : []), ...rebase.latest(raw).filter((r) => r.type === 'rebase')]
}

// Each line says what changed and how to go back (task p3e).
function text(r: HistoryRecord & { type: 'rebase' }, raw: HistoryRecord[]): string {
	let before = raw.slice(0, raw.findIndex((record) => record.n === r.n))
	let records = rebaseRows.build(before).records
	let boundary = (plan: HistoryRecord & { type: 'rebase' }) => plan.drop.length === 1 && !plan.edit.length ? before.find((x) => x.n === plan.drop[0] && (x.type === 'reset' || x.type === 'compact'))?.type : undefined
	if (!r.drop.length && !r.edit.length) {
		let undone = before.findLast((x) => x.type === 'rebase' && x.base === r.base && (x.drop.length || x.edit.length))
		let kind = undone?.type === 'rebase' ? boundary(undone) : undefined
		if (kind === 'reset') return 'Context cleared again; "/clear undo" to go back'
		if (kind === 'compact') return 'Context compacted again; "/compact undo" to go back'
		return 'History rewrite undone: the earlier history is back'
	}
	let kind = boundary(r)
	if (kind === 'reset') return 'Clear undone: the earlier context is back; "/rebase undo" to clear it again'
	if (kind === 'compact') return 'Compaction undone: the full context is back; "/rebase undo" to compact it again'
	let groups = rebase.groups(records)
	let hidden = new Set(r.drop.flatMap((n) => [...(groups.get(n) ?? [n])])).size
	let parts = [hidden && `${hidden} record${hidden === 1 ? '' : 's'} hidden`, r.edit.length && `${r.edit.length} edited`].filter(Boolean).join(', ')
	return `History rewritten: ${parts}; "/rebase undo" to go back`
}

function dividers(raw: HistoryRecord[]): { n: number; text: string; ts?: string; after?: number }[] {
	let kept = new Set(replay.current(raw).map((r) => r.n)), after: number | undefined
	return rebase.latest(raw).flatMap((r) => {
		if (r.type === 'rebase') return r.quiet ? [] : [{ n: r.n!, text: rebaseDisplay.text(r, raw), ts: r.ts, after }]
		if (kept.has(r.n)) after = r.n
		return []
	})
}

function insert(items: Item[], dividers: { n: number; text: string; ts?: string; after?: number }[] = []): Item[] {
	for (let d of dividers) {
		let at = d.after === undefined ? 0 : items.findLastIndex((item) => item.key.split('.')[0] === String(d.after)) + 1
		if (d.after !== undefined && !at) continue
		items.splice(at, 0, { type: 'divider', text: d.text, ...(d.ts !== undefined && { ts: d.ts }), key: String(d.n) })
	}
	return items
}

export const rebaseDisplay = { current, text, dividers, insert }
