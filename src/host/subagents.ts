// Sessions spawned by sessions (task t0): the spawn and wait tools
// (src/host/tools/) and what the host does for them. A spawned session
// sits in the tab after its owner's and gets its task as a message from
// its owner (task rj). Reports go back to the owner (task mt);
// autoclose owns tab closure and human promotion (task p87).

import { cpSync, existsSync, writeFileSync } from 'fs'
import { settings } from '../common/settings.ts'
import { liveFiles } from './live-file.ts'
import { promptCache } from './prompt-cache.ts'
import { lines } from '../common/lines.ts'
import type { ToolResultBlock } from '../common/blocks.ts'
import type { HistoryRecord } from '../common/replay.ts'
import type { SessionMeta, SpawnKind } from '../common/session.ts'
import { replay } from '../common/replay.ts'
import { states } from '../common/states.ts'
import { summary } from '../common/summary.ts'
import { blobs } from './blobs.ts'
import { diag } from './diag.ts'
import { host } from './host.ts'
import { history } from './history.ts'
import { greetings } from './greetings.ts'
import { prompts } from './prompts.ts'
import { sessions } from './sessions.ts'
import { status } from './status.ts'
import { tabs } from './tabs.ts'
import { models } from './models.ts'
import { auth } from './auth.ts'

export type Spawn = { kind: SpawnKind; task: string; fork: boolean; cwd: string; model?: string; name?: string; limit: number }

// Opens the child and starts its first turn; returns its id. Throws,
// spending nothing, when an owner ancestor has too few slots left or the
// child's model is rate limited on every account (it would only wait).
function spawn(owner: string, s: Spawn): string {
	let meta = sessions.open(owner)
	let selected = models.selection(s.model ?? models.qualified(meta.model, meta.effort))
	let limited = auth.limitedUntil(selected.id)
	if (limited) throw new Error(`${selected.id} is rate limited until ${new Date(limited).toISOString().slice(0, 16).replace('T', ' ')} UTC on every ${selected.id.split('/')[0]} account`)
	if (!Number.isSafeInteger(s.limit) || s.limit < 0) throw new Error('limit must be a non-negative integer')
	let charged: SessionMeta[] = []
	if (s.kind !== 'interactive') {
		let left = meta.slots ?? settings.subagentSlots()
		if (s.limit > left - 1) throw new Error(`limit ${s.limit} needs at least ${s.limit + 1} spawn slots, but this session has ${left} left`)
		for (let at: SessionMeta | undefined = meta; at; at = at.owner ? sessions.open(at.owner) : undefined) {
			if (charged.includes(at)) throw new Error(`owner cycle at ${at.id}`)
			if ((at.slots ?? settings.subagentSlots()) === 0) throw new Error(`session ${at.id} has 0 spawn slots left`)
			charged.push(at)
		}
	}
	let child = sessions.create({ cwd: s.cwd, model: models.qualified(selected.id, selected.effort), name: s.name, autoclose: s.kind === 'subagent' })
	Object.assign(child, { ...(s.kind !== 'interactive' && { owner, slots: s.limit }), spawn: s.kind } satisfies Partial<SessionMeta>)
	if (s.fork) subagents.fork(owner, child.id)
	liveFiles.save(child)
	for (let ancestor of charged) {
		ancestor.slots = (ancestor.slots ?? settings.subagentSlots()) - 1
		liveFiles.save(ancestor)
		host.broadcast(ancestor.id, { type: 'meta', sessionId: ancestor.id, meta: { ...ancestor } })
	}
	if (s.kind === 'interactive' && !s.task.trim() && !s.fork) greetings.open(child.id)
	let at = tabs.file().open.indexOf(owner)
	tabs.insert(child.id, at < 0 ? tabs.file().open.length : at + 1)
	tabs.publish()
	let text = s.task
	if (text.trim()) {
		let refused = prompts.submit(child.id, text, undefined, 'steer', { from: owner, label: tabs.label(owner) })
		if (refused) throw new Error(`${child.id} did not start: ${refused}`)
	}
	return child.id
}

// Gives the child the parent's history so far: its records as they
// are, without the parent's waiting inbox. The parent's turn is still
// running this round's calls, so the copy answers them and ends it.
function fork(parent: string, child: string): void {
	let records = replay.current(history.readSync(parent)).filter((r) => r.type !== 'inbox').map((r) => ({ ...r, originSession: r.originSession ?? parent }))
	writeFileSync(history.file(child), records.map((r) => lines.encode(r)).join(''))
	let source = sessions.open(parent), target = sessions.open(child)
	target.parent = parent
	if (source.startingState) target.startingState = { ...source.startingState }
	liveFiles.save(target)
	promptCache.inherit(parent, child)
	if (existsSync(blobs.dir(parent))) cpSync(blobs.dir(parent), blobs.dir(child), { recursive: true })
	let pending: string[] = []
	for (let r of records) {
		if (r.type === 'turn_end' || r.type === 'user') {
			if (r.type === 'turn_end') pending = []
			else for (let b of r.blocks) if (b.type === 'tool_result') pending = pending.filter((id) => id !== b.id)
		}
		if (r.type === 'assistant' && r.block.type === 'tool_call') pending.push(r.block.id)
	}
	let output = `This session is a fork of ${parent}; copied calls ran there, not here.`
	if (pending.length) history.append(child, { type: 'user', blocks: pending.map((id): ToolResultBlock => ({ type: 'tool_result', id, output })) })
	let last = records.findLast((r) => r.type === 'user' || r.type === 'assistant' || r.type === 'continue' || r.type === 'turn_end')
	if (last && last.type !== 'turn_end') history.append(child, { type: 'turn_end', status: 'completed', usage: {} })
	let previous = { cwd: source.cwd, model: models.qualified(source.model, source.effort), autoclose: source.autoclose ?? false }
	let next = { cwd: target.cwd, model: models.qualified(target.model, target.effort), autoclose: target.autoclose ?? false }
	let changed = Object.fromEntries(Object.entries(next).filter(([key, value]) => value !== previous[key as keyof typeof previous]))
	if (Object.keys(changed).length) history.append(child, { type: 'change', ...changed, previous })
	history.append(child, { type: 'output', text: output })
}

// The owner's subagents still at work: what wait waits for.
function running(owner: string): string[] {
	return sessions.openIds().filter((id) => {
		let meta = sessions.open(id)
		return meta.owner === owner && meta.spawn !== 'interactive' && states.busy(status.stateOf(id))
	})
}

// Whether the session's last turn reports to its owner: the owner
// started it (its first task or a later message), or continued work of
// one it started (a continue, or a turn woken by the session's own
// subagent or background command). A human's prompt or another session's starts work that
// reports nothing.
function owed(id: string, records: HistoryRecord[]): boolean {
	let owner = sessions.open(id).owner
	if (!owner) return false
	let owned = false
	let reports = false
	let starts = true
	for (let r of records) {
		if (r.type === 'turn_end') starts = true
		else if (r.type === 'continue' || r.type === 'assistant') starts = false
		else if (r.type === 'user' && starts) {
			let first = r.blocks.find((b) => b.type === 'text')
			if (!first) continue
			starts = false
			if (first.from === owner) owned = reports = true
			else if (first.origin === 'model') reports = owned
			else if (first.from === undefined) owned = reports = false
			else reports = owned && (first.from === id || sessions.open(first.from).owner === id)
		}
	}
	return reports
}

// After a subagent's turn ended: its owner hears how, as an advisory
// message from it, so no owner waits for a child that stopped. A turn
// ended by wait is not over yet: its subagents' reports go on with it.
function report(id: string): void {
	let meta = sessions.open(id)
	if (!meta.owner || !meta.spawn || meta.spawn === 'interactive') return
	let records = history.readSync(id)
	let end = records.at(-1)
	if (end?.type !== 'turn_end' || (end.status === 'completed' && end.reason === 'tool_use')) return
	if (!subagents.owed(id, records)) return
	let label = tabs.label(id)
	let text: string
	if (end.status === 'error') text = `Session ${label} stopped: ${end.error ?? 'its turn failed'}`
	else if (end.status === 'paused') text = `Session ${label} stopped: ${end.pauseReason ?? 'the user paused it'}`
	else {
		let turn = records.slice(records.findLastIndex((r, i) => r.type === 'turn_end' && i < records.length - 1) + 1)
		let last = turn.findLast((r) => r.type === 'assistant' && r.block.type === 'text' && r.block.text.trim())
		text = last?.type === 'assistant' && last.block.type === 'text' ? last.block.text : `Session ${label} finished without a message`
	}
	let owner = meta.owner
	let deliver = () => {
		// A child stopped by tab close must not wake an idle, now unseen owner.
		if (tabs.file().closed.some((tab) => tab.id === owner) && !tabs.file().open.includes(owner)) return
		let refused = prompts.submit(owner, text, undefined, 'steer', { from: id, label, advisory: true, summary: summary.extract(text), ...(summary.extract(text) && end.status === 'completed' ? { report: summary.asks(text) ? 'question' as const : 'summary' as const } : {}) })
		if (refused) diag.log(`report ${id} to ${owner}: ${refused}`)
	}
	let ready = host.ready(owner)
	if (!ready) return deliver()
	ready.then(deliver, (e) => diag.log(`report ${id} to ${owner}: ${e?.message ?? e}`))
}

export const subagents = {
	spawn,
	fork,
	running,
	owed,
	report,
}
