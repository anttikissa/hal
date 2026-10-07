// What an applied rebase changed, shown in the transcript (task qb1):
// each dropped row's summary and each edit as a line diff, complete.
import type { RebasePlan } from '../common/rebase.ts'
import type { RebaseRows } from '../common/rebase-rows.ts'
import { promptTrail } from './prompt-trail.ts'

function text(snapshot: RebaseRows, plan: RebasePlan): string {
	let drops = new Set(plan.drop), lines = ['Rebase applied.']
	for (let row of snapshot.rows) if (row.ns.some((n) => drops.has(n))) lines.push(`Dropped #${row.n} ${row.kind}: ${row.summary}`)
	for (let e of plan.edit) {
		let row = snapshot.rows.find((r) => r.editN === e.n) ?? snapshot.rows.find((r) => r.n === e.n)
		lines.push(`Edited #${row?.n ?? e.n} ${row?.kind ?? 'record'}:`, promptTrail.diff(row?.text ?? '', e.text, Infinity))
	}
	return lines.join('\n')
}

export const rebaseReport = { text }
