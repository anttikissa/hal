// Rebase controls are display-only; provider replay still excludes them.
import { rebase } from './rebase.ts'
import { rebaseRows } from './rebase-rows.ts'
import type { Item } from './transcript.ts'
import { replay, type HistoryRecord } from './replay.ts'

function current(raw: HistoryRecord[]): HistoryRecord[] {
	let projected = replay.current(raw), active = new Set(projected), byNumber = new Map(projected.filter((r) => r.n !== undefined).map((r) => [r.n, r]))
	let candidates: HistoryRecord[] = raw.filter((r) => r.type !== 'rebase')
	for (let r of rebase.latest(raw)) if (r.type === 'rebase') candidates = rebase.apply(candidates, r)
	return [...candidates.map((r) => active.has(r) ? r : byNumber.get(r.n) ?? { ...r, canceledReference: true as const }), ...rebase.latest(raw).filter((r) => r.type === 'rebase')]
}

function text(r: HistoryRecord & { type: 'rebase' }, raw: HistoryRecord[]): string {
	if (!r.drop.length && !r.edit.length) return 'History rewrite undone.'
	let before = raw.slice(0, raw.findIndex((record) => record.n === r.n))
	let snapshot = rebaseRows.build(before), sums = rebaseRows.totals(snapshot, r)
	let groups = rebase.groups(snapshot.records)
	let dropped = new Set(r.drop.flatMap((n) => [...(groups.get(n) ?? [n])])).size
	return `History rewritten · /rebase undo · ${dropped} dropped, ${r.edit.length} edited · cache rebuilds from #${sums.cacheFrom}`
}

function dividers(raw: HistoryRecord[]): { n: number; text: string; ts?: string; after?: number }[] {
	let kept = new Set(replay.current(raw).map((r) => r.n)), after: number | undefined
	return rebase.latest(raw).flatMap((r) => {
		if (r.type === 'rebase') return [{ n: r.n!, text: rebaseDisplay.text(r, raw), ts: r.ts, after }]
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
