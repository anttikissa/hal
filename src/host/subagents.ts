// Sessions spawned by sessions (task t0): the spawn and wait tools
// (src/host/tools/) and what the host does for them. A spawned session
// sits in the tab after its parent's and gets its first prompt from the
// parent, as a message the parent sent (task rj). When a turn the parent
// asked for ends, the host sends the parent its last text (report, task
// mt); a `subagent`'s tab then closes after a clean finish unless a
// human prompted it (promote). Spawn slots only go down: a
// parent spends limit + 1 for a child given `limit`.

import { cpSync, existsSync, writeFileSync } from 'fs'
import { lines } from '../common/lines.ts'
import type { ToolResultBlock } from '../common/blocks.ts'
import type { HistoryRecord } from '../common/replay.ts'
import type { SessionMeta, SpawnKind } from '../common/session.ts'
import { states } from '../common/states.ts'
import { blobs } from './blobs.ts'
import { diag } from './diag.ts'
import { host } from './host.ts'
import { history } from './history.ts'
import { jobs } from './jobs.ts'
import { prompts } from './prompts.ts'
import { sessions } from './sessions.ts'
import { status } from './status.ts'
import { tabs } from './tabs.ts'

export type Spawn = { kind: SpawnKind; task: string; fork: boolean; cwd: string; model?: string; name?: string; limit: number }

// Opens the child and starts its first turn; returns its id. Throws,
// spending nothing, when the parent has too few slots left.
function spawn(parent: string, s: Spawn): string {
	let meta = sessions.open(parent)
	let left = meta.slots ?? subagents.initialSlots()
	if (s.limit + 1 > left) throw new Error(`limit ${s.limit} needs ${s.limit + 1} spawn slots, but this session has ${left} left`)
	meta.slots = left - s.limit - 1
	let child = sessions.create({ cwd: s.cwd, model: s.model ?? meta.model, name: s.name })
	Object.assign(child, { parent, spawn: s.kind, slots: s.limit } satisfies Partial<SessionMeta>)
	if (s.fork) subagents.fork(parent, child.id)
	let at = tabs.file().open.indexOf(parent)
	tabs.insert(child.id, at < 0 ? tabs.file().open.length : at + 1)
	tabs.publish()
	let text = s.kind === 'interactive' ? s.task : subagents.prompt(parent, s.task, s.kind, s.limit)
	if (text.trim()) {
		let refused = prompts.submit(child.id, text, undefined, false, { from: parent, label: tabs.label(parent) })
		if (refused) throw new Error(`${child.id} did not start: ${refused}`)
	}
	return child.id
}

// The child's first prompt: whose it is, what it may spawn, and that its
// last message goes back.
function prompt(parent: string, task: string, kind: SpawnKind, slots: number): string {
	return [
		`You are a subagent session working for parent session ${parent}.`,
		`You may spawn at most ${slots} session${slots === 1 ? '' : 's'} of your own.`,
		'',
		'Task:',
		task,
		'',
		`Your last message when you finish is returned to session ${parent}: make it a concise handoff (summary, files changed, open questions).`,
		kind === 'subagent' ? 'Hal then closes this tab.' : 'This tab stays open for the user.',
	].join('\n')
}

// Gives the child the parent's history so far: its records as they
// are, without the parent's waiting inbox. The parent's turn is still
// running this round's calls, so the copy answers them and ends it.
function fork(parent: string, child: string): void {
	let records = history.readSync(parent).filter((r) => r.type !== 'inbox')
	writeFileSync(history.file(child), records.map((r) => lines.encode(r)).join(''))
	if (existsSync(blobs.dir(parent))) cpSync(blobs.dir(parent), blobs.dir(child), { recursive: true })
	let pending: string[] = []
	for (let r of records) {
		if (r.type === 'turn_end' || r.type === 'user') pending = []
		if (r.type === 'assistant' && r.block.type === 'tool_call') pending.push(r.block.id)
	}
	let output = `This session is a fork of ${parent}, made by this round's calls, which ran there, not here.`
	if (pending.length) history.append(child, { type: 'user', blocks: pending.map((id): ToolResultBlock => ({ type: 'tool_result', id, output })) })
	let last = records.findLast((r) => r.type === 'user' || r.type === 'assistant' || r.type === 'continue' || r.type === 'turn_end')
	if (last && last.type !== 'turn_end') history.append(child, { type: 'turn_end', status: 'completed', usage: {} })
}

// The parent's subagents still at work: what wait waits for.
function running(parent: string): string[] {
	return sessions.openIds().filter((id) => {
		let meta = sessions.open(id)
		return meta.parent === parent && meta.spawn !== 'interactive' && states.busy(status.stateOf(id))
	})
}

// Whether the session's last turn reports to its parent: the parent
// started it (its first task or a later message), or continued work of
// one it started (a continue, or a turn woken by the session's own
// subagent or background command). A human's prompt or another session's starts work that
// reports nothing.
function owed(id: string, records: HistoryRecord[]): boolean {
	let parent = sessions.open(id).parent
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
			if (first.from === parent) owned = reports = true
			else if (first.from === undefined) owned = reports = false
			else reports = owned && (first.from === id || sessions.open(first.from).parent === id)
		}
	}
	return reports
}

// After a subagent's turn ended: its parent hears how, as an advisory
// message from it, so no parent waits for a child that stopped. A turn
// ended by wait is not over yet: its subagents' reports go on with it.
function report(id: string): void {
	let meta = sessions.open(id)
	if (!meta.parent || !meta.spawn || meta.spawn === 'interactive') return
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
	let parent = meta.parent
	let deliver = () => {
		let refused = prompts.submit(parent, text, undefined, false, { from: id, label, advisory: true })
		if (refused) diag.log(`report ${id} to ${parent}: ${refused}`)
	}
	let ready = host.ready(parent)
	if (!ready) return deliver()
	ready.then(deliver, (e) => diag.log(`report ${id} to ${parent}: ${e?.message ?? e}`))
}

// After a completed turn: a subagent with nothing left to do closes its
// tab. One waiting for subagents of its own, or with messages waiting,
// is not done.
function finished(id: string): void {
	if (sessions.open(id).spawn !== 'subagent' || status.stateOf(id).type !== 'idle') return
	if (status.inboxOf(id).length || subagents.running(id).length || jobs.running(id).length) return
	if (tabs.close(id) === undefined) tabs.publish()
}

// A human prompted it: the tab is theirs now and stays open.
function promote(id: string): void {
	let meta = sessions.open(id)
	if (meta.spawn === 'subagent') meta.spawn = 'subagent-leave-open'
}

export const subagents = {
	// Slots of a session nobody spawned.
	initialSlots: () => 5,
	spawn,
	prompt,
	fork,
	running,
	owed,
	report,
	finished,
	promote,
}
