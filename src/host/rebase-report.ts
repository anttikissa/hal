// What an applied rebase changed, shown in the transcript (tasks qb1, 18n):
// dropped rows as ranges and each edit as a line diff, complete.
import { rebase, type RebasePlan } from '../common/rebase.ts'
import { rebaseRows, type RebaseRows } from '../common/rebase-rows.ts'
import { textDiff } from './text-diff.ts'
import { diff } from '../common/diff.ts'

function text(snapshot: RebaseRows, plan: RebasePlan, paused = false, continuation?: 'prompt' | 'unfinished'): string {
	let groups = rebase.groups(snapshot.records)
	let drops = new Set(plan.drop.flatMap((n) => [...(groups.get(n) ?? [n])])),
		runs: number[][] = [],
		last = -2
	// Consecutive dropped entries as one range: '43-95 (40 entries), t104'.
	snapshot.rows.forEach((row, i) => {
		if (!row.ns.some((n) => drops.has(n))) return
		if (i === last + 1) runs.at(-1)!.push(row.n)
		else runs.push([row.n])
		last = i
	})
	let count = runs.reduce((sum, run) => sum + run.length, 0),
		entries = (k: number) => `${k} ${k === 1 ? 'entry' : 'entries'}`
	let id = (n: number) => rebaseRows.cardOf(snapshot.rows, n)
	let ranges = runs.map((run) => (run.length === 1 ? id(run[0]!) : `${run[0]}-${run.at(-1)} (${entries(run.length)})`))
	let summary = `Rebase applied (dropped ${entries(count)}, edited ${plan.edit.length}${continuation ? `; continuing ${continuation === 'prompt' ? 'after user prompt' : 'unfinished turn'}` : ''})`
	let lines = [
		summary,
		...(count ? [`Dropped ${entries(count)}: ${ranges.join(', ')}`] : []),
		...(paused ? ['--paused'] : []),
	]
	for (let e of plan.edit) {
		let row = snapshot.rows.find((r) => r.editN === e.n) ?? snapshot.rows.find((r) => r.n === e.n)
		let changes = textDiff
			.text(row?.text ?? '', e.text)
			.split('\n')
			.filter((line) => line !== '\\ No newline at end of file')
			.join('\n')
		lines.push(`Edited ${row ? `${rebaseRows.id(row)} (${row.kind})` : e.n}:`, diff.fence(changes))
	}
	return lines.join('\n')
}

export const rebaseReport = { text }
