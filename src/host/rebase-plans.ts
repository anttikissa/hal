// Client-local plans; only the host validates and writes history (task z71).
import { rebase, type RebasePlan } from '../common/rebase.ts'
import { rebaseRows, type RebaseRows } from '../common/rebase-rows.ts'
import type { Command, Event } from '../common/protocol.ts'
import { forms } from '../common/forms.ts'
import { replay } from '../common/replay.ts'
import { states } from '../common/states.ts'
import { readdirSync, statSync, existsSync } from 'fs'
import { blobs } from './blobs.ts'
import { history } from './history.ts'
import { host } from './host.ts'
import { prompts } from './prompts.ts'
import { pruning } from './pruning.ts'
import { rebases } from './rebases.ts'
import { slash } from './slash.ts'
import { sessions } from './sessions.ts'
import { snapshots } from './snapshots.ts'
import { status } from './status.ts'
import { tokenCalibration } from './token-calibration.ts'

function build(id: string): RebaseRows {
	let raw = history.readSync(id)
	if (states.busy(status.stateOf(id)) || history.state.running.has(id) || forms.open(raw)) throw new Error('Pause the session and answer or dismiss its question before rebasing.')
	let blobSizes: Record<string, number> = {}, dir = blobs.dir(id)
	if (existsSync(dir)) for (let name of readdirSync(dir)) blobSizes[name.split('.')[0]!] = statSync(`${dir}/${name}`).size
	return rebaseRows.build(raw, { model: sessions.open(id).model, ratios: tokenCalibration.ratios(), blobSizes, pruned: pruning.saved(id).omitted })
}

function broadcast(id: string, from: number): void {
	host.broadcast(id, { type: 'history-rewritten', sessionId: id, from, snapshot: snapshots.build(id) })
}

function apply(c: Command & { type: 'rebase-apply' }): string {
	let snapshot = rebasePlans.build(c.sessionId)
	if (snapshot.base !== c.base) throw new Error(`Rebase is stale: base #${c.base}, latest record #${snapshot.base}. Rebuild the plan.`)
	let parsed = c.todo === undefined ? undefined : rebaseRows.parse(c.todo, snapshot, c.replacements)
	if (parsed?.aborted) return 'Rebase aborted.'
	if (parsed?.edits.length) throw new Error(`Rebase edits missing full text: ${parsed.edits.map((n) => `#${n}`).join(', ')}`)
	let plan = parsed?.plan ?? c.plan!, queue = parsed?.queue ?? []
	if (plan.base !== c.base) throw new Error('Rebase plan base does not match the requested base.')
	// Queue entries must be prompts, not a second channel for slash commands.
	if (queue.some((text) => /^\s*\/[a-z][a-z0-9-]*(?:\s|$)/.test(text))) throw new Error('Rebase queue lines must be prompts, not slash commands.')
	plan = { ...plan, edit: plan.edit.filter((e) => snapshot.rows.find((row) => row.editN === e.n)?.text !== e.text) }
	let sums = rebaseRows.totals(snapshot, plan)
	if (plan.drop.length || plan.edit.length) {
		rebases.apply(c.sessionId, plan, c.base)
		rebasePlans.broadcast(c.sessionId, sums.cacheFrom ?? c.base)
	}
	for (let [i, text] of queue.entries()) {
		let refused = prompts.submit(c.sessionId, text, undefined, i > 0)
		if (refused) throw new Error(refused)
	}
	return plan.drop.length || plan.edit.length ? `History rewritten.${queue.length ? ` Queued ${queue.length} prompts.` : ''}` : queue.length ? `Queued ${queue.length} prompts.` : 'Rebase unchanged.'
}

function undo(id: string): string {
	let snapshot = rebasePlans.build(id), raw = history.readSync(id)
	let last = rebase.latest(raw).findLast((r) => r.type === 'rebase' && (r.drop.length || r.edit.length))
	if (!last || last.type !== 'rebase') throw new Error('No rebase to undo.')
	let plan: RebasePlan = { base: last.base, drop: [], edit: [] }
	rebases.apply(id, plan, snapshot.base)
	let before = raw.slice(0, raw.findIndex((r) => r.n === last.n))
	rebasePlans.broadcast(id, rebaseRows.totals(rebaseRows.build(before), last).cacheFrom ?? last.base)
	return 'Rebase undone.'
}

// Edits prompt #n and rewinds there (task 26q), as one command: a
// rebase dropping #n and every later record except inbox, answer and
// change records (as a replacing prompt keeps them), then the edited
// text sent as a new prompt. Returns why it is refused, if it is.
function rewind(id: string, n: number, text: string, command?: string): string | undefined {
	let raw = history.readSync(id), state = status.stateOf(id, raw).type
	if (state !== 'idle' && state !== 'paused') return `Can't rewind while the session is ${state}; pause it first.`
	let current = replay.current(raw), at = current.findIndex((r) => r.n === n), target = current[at]
	let mine = target?.type === 'user' && target.blocks.some((b) => b.type === 'text' && b.from === undefined && b.origin !== 'model')
	if (!mine) return `#${n} is not a prompt of yours in this session's history (rewritten meanwhile?).`
	let later = current.slice(at)
	if (later.some((r) => r.type === 'compact' || r.type === 'reset')) return `#${n} is before the latest compaction or clear.`
	let drop = later.flatMap((r) => (r.n === undefined || r.type === 'inbox' || r.type === 'answer' || r.type === 'change' ? [] : [r.n]))
	rebases.apply(id, { base: raw.at(-1)?.n ?? 0, drop, edit: [] })
	rebasePlans.broadcast(id, n)
	return prompts.submit(id, text, command)
}

function answer(c: Command & { type: 'rebase-apply' }): Event {
	let result: Event & { type: 'rebase-result' } = { type: 'rebase-result', sessionId: c.sessionId, command: c.id, ok: true, text: '' }
	try { result.text = rebasePlans.apply(c) }
	catch (error) {
		result.ok = false
		result.text = `${error instanceof Error ? error.message : String(error)}${c.recoveryPath ? `\nRebase files kept at ${c.recoveryPath}` : ''}`
		slash.output(c.sessionId, result.text, true)
	}
	return result
}

export const rebasePlans = { build, broadcast, apply, undo, rewind, answer }
