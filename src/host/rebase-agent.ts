// Sparse plans and durable round-boundary execution. Validation and reporting
// finish before any drop; open tails include the settled executing exchange.
// Tasks: svt.
import type { Sender, ToolResultBlock } from '../common/blocks.ts'
import type { ContextTransition } from '../common/context-transition.ts'
import { rebase, type RebasePlan } from '../common/rebase.ts'
import { forms } from '../common/forms.ts'
import { rebaseRows, type RebaseRows } from '../common/rebase-rows.ts'
import { rebaseSparse, type SparseRebase } from '../common/rebase-sparse.ts'
import { replay, type HistoryRecord } from '../common/replay.ts'
import { contextTransitions } from './context-transitions.ts'
import { history } from './history.ts'
import { host } from './host.ts'
import { prompts } from './prompts.ts'
import { rebasePlans } from './rebase-plans.ts'
import { rebaseReport } from './rebase-report.ts'
import { rebases } from './rebases.ts'
import { sessions } from './sessions.ts'
import { slash } from './slash.ts'
import { status } from './status.ts'
import { turns } from './turns.ts'

export type RebaseIntent = { sparse: SparseRebase; paused?: true; resume?: true; call?: string }

function snapshot(id: string): RebaseRows {
	return rebaseRows.build(history.readSync(id))
}

// Append-only activity does not invalidate shown IDs. A context boundary,
// rebase or replacement prompt does, even if it happens to restore the text.
function fresh(raw: HistoryRecord[], base: number): void {
	if (base && !raw.some((r) => r.n === base)) throw new Error(`Rebase snapshot #${base} is missing; run /rebase show again.`)
	if (raw.some((r) => r.n! > base && (r.type === 'rebase' || r.type === 'reset' || r.type === 'compact' || (r.type === 'user' && r.replaces)))) throw new Error(`Rebase snapshot #${base} is stale: context was rewritten. Run /rebase show again.`)
}

function show(id: string): string {
	let snapshot = rebaseAgent.snapshot(id)
	rebaseAgent.state.shown.set(sessions.open(id), snapshot)
	return rebaseRows.render(id, snapshot).replace(/# keep\/drop\/edit\/queue[^\n]*\n# edit[^\n]*/, '# Sparse plan: unmentioned entries stay. drop targets; edit #n "full replacement".\n# Open tails (12-, t12-, *) resolve through application, including this rebase call/result.')
}

function shown(id: string): RebaseRows {
	let snapshot = rebaseAgent.state.shown.get(sessions.open(id))
	if (!snapshot) return rebaseAgent.snapshot(id)
	rebaseAgent.fresh(history.readSync(id), snapshot.base)
	return snapshot
}

function prepare(id: string, intent: RebaseIntent, raw = history.readSync(id)) {
	rebaseAgent.fresh(raw, intent.sparse.plan.base)
	if (forms.open(raw)) throw new Error('Answer or dismiss the open question before rebasing.')
	let snapshot = rebaseRows.build(raw), plan = rebaseSparse.resolve(intent.sparse, snapshot)
	plan.edit = plan.edit.filter((e) => snapshot.rows.find((row) => row.editN === e.n)?.text !== e.text)
	// Each application has its own base; repeated sparse plans compose, rather
	// than replacing an earlier rebase against the same shown snapshot.
	plan.base = snapshot.base
	let sums = rebaseRows.totals(snapshot, plan)
	let continuation = rebaseAgent.continuation(raw, plan, intent.paused, intent.resume)
	return { plan, continuation, from: sums.cacheFrom ?? snapshot.base, report: rebaseReport.text(snapshot, plan, intent.paused, continuation) }
}

function request(id: string, text: string, preview: boolean, paused: boolean, sender: Sender = {}): string {
	let sparse = rebaseSparse.parse(text, rebaseAgent.shown(id))
	let state = status.stateOf(id), call = state.type === 'running' && state.phase === 'tools' ? state.call : undefined
	let intent: RebaseIntent = { sparse, ...(turns.state.running.has(id) && { resume: true }), ...(paused && { paused: true }), ...(sender.origin === 'model' && call && { call }) }
	let prepared = rebaseAgent.prepare(id, intent)
	if (preview) return prepared.report.replace(/^Rebase applied(?:\.)?/, 'Rebase preview; no changes.') + (sparse.tails.length ? '\nOpen tails resolve again through application time, including the executing rebase call/result and intervening entries.' : '')
	if (contextTransitions.pending(id)) throw new Error('A context transition is already pending; wait or press Escape.')
	let transition: ContextTransition = { id: crypto.randomUUID(), kind: 'rebase', sender, rebase: intent }
	contextTransitions.output(id, '/rebase accepted; applying after active work settles.', { transition })
	if (!turns.state.running.has(id)) contextTransitions.apply(id)
	return '/rebase accepted; the settled exchange will report its outcome before the next request.'
}

// Completion belongs to the original final assistant entry of that turn.
// A retained turn_end cannot finish commentary exposed by dropping its reply.
function continuation(raw: HistoryRecord[], plan?: RebasePlan, paused = false, resume = false): 'prompt' | 'unfinished' | undefined {
	if (paused) return
	let before = replay.current(raw), after = plan ? rebase.apply(before, plan) : before
	let conversational = (r: HistoryRecord) => r.type === 'assistant' || (r.type === 'user' && r.blocks.some((b) => b.type === 'text' || b.type === 'image'))
	let last = after.findLast(conversational)
	if (last?.type === 'user') return 'prompt'
	if (resume) return 'unfinished'
	if (!last) return
	let at = before.findIndex((r) => r.n === last.n)
	let tail = before.slice(at + 1), end = tail.findIndex((r) => r.type === 'turn_end')
	let completed = end >= 0 && tail[end]!.type === 'turn_end' && tail[end]!.status === 'completed'
	if (completed && after.some((r) => r.n === tail[end]!.n) && !tail.slice(0, end).some(conversational)) return
	return 'unfinished'
}

function continuePrompt(id: string, paused = false, reason = rebaseAgent.continuation(history.readSync(id), undefined, paused)): void {
	if (paused || turns.state.running.has(id) || !reason) return
	let refused = prompts.resume(id)
	if (refused) throw new Error(refused)
}

function apply(id: string, transition: ContextTransition, prepared?: ReturnType<typeof prepare>): boolean {
	let intent = transition.rebase!
	if (transition.canceled) {
		contextTransitions.output(id, '/rebase canceled; history unchanged.', { transitionDone: transition.id })
		return false
	}
	let raw = history.readSync(id)
	let applied = raw.some((r) => r.type === 'rebase' && r.transition === transition.id)
	let result: ReturnType<typeof prepare> | undefined
	try {
		if (!applied) {
			result = prepared ?? rebaseAgent.prepare(id, intent)
			rebases.apply(id, result.plan, result.plan.base, { boundary: true, transition: transition.id })
		}
	} catch (error) {
		let text = `Rebase failed: ${error instanceof Error ? error.message : String(error)}`
		slash.output(id, text, true)
		history.append(id, { type: 'notice', text })
		let start = intent.resume && !turns.state.running.has(id)
		if (start) history.append(id, { type: 'continue' })
		contextTransitions.output(id, text, { transitionDone: transition.id })
		if (start) { status.transition(id, { type: 'submit' }); turns.start(id) }
		return false
	}
	// The commit is durable. Later presentation/storage failures must not
	// claim the rewrite failed or replay it; recovery recognizes its intent.
	rebaseAgent.state.shown.delete(sessions.open(id))
	if (result) {
		rebasePlans.broadcast(id, result.from)
		slash.output(id, result.report)
	}
	let start = !turns.state.running.has(id) && !intent.paused && (result?.continuation ?? rebaseAgent.continuation(history.readSync(id), undefined, false, intent.resume))
	if (start) history.append(id, { type: 'continue' })
	else if (!turns.state.running.has(id) && history.unfinished(id)) history.append(id, { type: 'turn_end', status: 'paused', usage: {} })
	contextTransitions.output(id, '/rebase applied.', { transitionDone: transition.id })
	if (start) { status.transition(id, { type: 'submit' }); turns.start(id) }
	return !!intent.paused
}

// The virtual result gets a real reserved number. Preflight can therefore
// include its linkage in exactly the plan applied synchronously after writing
// it. Failures become the calling tool's error before its first durable write.
function results(id: string, results: ToolResultBlock[]): { record?: HistoryRecord; paused: boolean } {
	let transition = contextTransitions.pending(id)
	if (transition?.kind !== 'rebase' || transition.canceled) {
		let record = history.results(id, results)
		host.broadcast(id, { type: 'tool-results', sessionId: id, results, n: record?.n, ts: record?.ts })
		return { record, paused: false }
	}
	let record: HistoryRecord = { type: 'user', blocks: results, n: history.number(id), ts: new Date().toISOString() }
	let prepared: ReturnType<typeof prepare> | undefined, failure: string | undefined
	let result = results.find((r) => r.id === transition.rebase?.call)
	try {
		prepared = rebaseAgent.prepare(id, transition.rebase!, [...history.readSync(id), record])
		if (result) result.output = prepared.report
	} catch (error) {
		let text = `Rebase failed: ${error instanceof Error ? error.message : String(error)}`
		if (result) { result.output = text; result.isError = true }
		failure = text
	}
	let written = history.append(id, record)
	if (failure) {
		slash.output(id, failure, true)
		if (!result) history.append(id, { type: 'notice', text: failure })
		contextTransitions.output(id, failure, { transitionDone: transition.id })
	}
	host.broadcast(id, { type: 'tool-results', sessionId: id, results, n: written.n, ts: written.ts })
	return { record: written, paused: prepared ? rebaseAgent.apply(id, transition, prepared) : false }
}

export const rebaseAgent = { state: { shown: new WeakMap<object, RebaseRows>() }, snapshot, fresh, show, shown, prepare, request, continuation, continuePrompt, apply, results }
