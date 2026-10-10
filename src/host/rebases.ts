// The synchronous host boundary: refuse stale plans and busy sessions before writing.
// Tasks: 3zz, z71, svt.
import { forms } from '../common/forms.ts'
import { rebase, type RebasePlan } from '../common/rebase.ts'
import { replay, type HistoryRecord } from '../common/replay.ts'
import { states } from '../common/states.ts'
import { history } from './history.ts'
import { sessions } from './sessions.ts'
import { models } from './models.ts'
import { liveFiles } from './live-file.ts'
import { host } from './host.ts'
import { stats } from './stats.ts'
import { promptCache } from './prompt-cache.ts'
import { sessionSettings } from './session-settings.ts'
import { status } from './status.ts'

function apply(id: string, plan: RebasePlan, expectedBase = plan.base, options: { boundary?: boolean; transition?: string } = {}): HistoryRecord {
	let raw = history.readSync(id)
	if ((!options.boundary && (states.busy(status.stateOf(id)) || history.state.running.has(id))) || forms.open(raw)) throw new Error('Pause the session and answer or dismiss its question before rebasing.')
	if ((raw.at(-1)?.n ?? 0) !== expectedBase) throw new Error(`Rebase is stale: base #${expectedBase}, latest record #${raw.at(-1)?.n ?? 0}. Rebuild the plan.`)
	let problem = rebase.invalid(plan)
	if (problem) throw new Error(problem)
	if (plan.base !== expectedBase && !raw.some((r) => r.type === 'rebase' && r.base === plan.base)) throw new Error('Undo base has no earlier rebase.')
	let current = replay.current([...raw, { type: 'rebase', ...plan, ts: new Date().toISOString() }])
	let meta = sessions.open(id)
	let changes = (records: HistoryRecord[]) => replay.current(records).filter((r) => r.type === 'change')
	let settingEdits = JSON.stringify(changes(raw)) !== JSON.stringify(changes(current))
	let settings = settingEdits ? sessionSettings.project(meta, current) : undefined
	let contextChanged = settings !== undefined && (meta.cwd !== settings.cwd || models.qualified(meta.model, meta.effort) !== settings.model || (meta.autoclose ?? false) !== settings.autoclose || meta.previousCwd !== settings.previousCwd)
	let state = states.fromHistory(current)
	let last = current.findLast((r) => r.type === 'assistant' || (r.type === 'user' && r.blocks.length > 0))
	let unanswered = last?.type === 'user' && last.blocks.some((b) => b.type === 'text')
	// Pause first: a failed rewrite commit leaves the original content, not a
	// committed drop reported as a failure. Continuation belongs to the caller.
	let pausing = !history.state.running.has(id) && (state.type === 'running' || (state.type === 'idle' && unanswered))
	if (pausing) history.append(id, { type: 'turn_end', status: 'paused', usage: {} })
	if (!history.state.running.has(id)) status.state.states.delete(id)
	status.state.derived.delete(id)
	let record: HistoryRecord
	try { record = history.append(id, { type: 'rebase', ...plan, ...(contextChanged && { contextChanged: true }), ...(options.transition && { transition: options.transition }) }) }
	catch (error) {
		if (pausing) throw new Error(`Rebase was not applied; the session is paused.\n${error instanceof Error ? error.message : String(error)}`)
		throw error
	}
	try {
		if (settings) { sessionSettings.assign(meta, settings); liveFiles.save(meta) }
		if (contextChanged) promptCache.rebased(id)
		host.broadcast(id, { type: 'meta', sessionId: id, meta: { ...meta }, stats: stats.of(id) })
	} catch (error) {
		throw new Error(`Rebase applied as #${record.n}; settings synchronization failed. Reopening recovers settings from history.\n${error instanceof Error ? error.message : String(error)}`)
	}
	return record
}

export const rebases = { apply }
