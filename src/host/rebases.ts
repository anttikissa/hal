// The synchronous host boundary: refuse stale plans and busy sessions before writing.
import { forms } from '../common/forms.ts'
import { rebase, type RebasePlan } from '../common/rebase.ts'
import { replay, type HistoryRecord } from '../common/replay.ts'
import { states } from '../common/states.ts'
import { history } from './history.ts'
import { status } from './status.ts'

function apply(id: string, plan: RebasePlan, expectedBase = plan.base): HistoryRecord {
	let raw = history.readSync(id)
	if (states.busy(status.stateOf(id)) || history.state.running.has(id) || forms.open(raw)) throw new Error('Pause the session and answer or dismiss its question before rebasing.')
	if ((raw.at(-1)?.n ?? 0) !== expectedBase) throw new Error(`Rebase is stale: base #${expectedBase}, latest record #${raw.at(-1)?.n ?? 0}. Rebuild the plan.`)
	let problem = rebase.invalid(plan)
	if (problem) throw new Error(problem)
	if (plan.base !== expectedBase && !raw.some((r) => r.type === 'rebase' && r.base === plan.base)) throw new Error('Undo base has no earlier rebase.')
	let current = replay.current([...raw, { type: 'rebase', ...plan, ts: new Date().toISOString() }])
	let state = states.fromHistory(current)
	let last = current.findLast((r) => r.type === 'assistant' || (r.type === 'user' && r.blocks.length > 0))
	let unanswered = last?.type === 'user' && last.blocks.some((b) => b.type === 'text')
	let record = history.append(id, { type: 'rebase', ...plan })
	// Rewritten context is never permission to start a request, even on takeover.
	if (state.type === 'running' || (state.type === 'idle' && unanswered)) history.append(id, { type: 'turn_end', status: 'paused', usage: {} })
	status.state.states.delete(id)
	status.state.derived.delete(id)
	return record
}

export const rebases = { apply }
