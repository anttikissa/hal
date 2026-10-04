// Live queue-edit ownership belongs to a connection, never its untrusted token.
// The pause is durable; the hold is not, so a replacement host stays paused.
import type { Command, Event } from '../common/protocol.ts'
import { forms } from '../common/forms.ts'
import { states } from '../common/states.ts'
import { commands } from './commands.ts'
import { history } from './history.ts'
import { liveFiles } from './live-file.ts'
import { paths } from './paths.ts'
import { host } from './host.ts'
import { prompts } from './prompts.ts'
import { status } from './status.ts'
import { turns } from './turns.ts'

// Durable pause intent is separate from turn completion: interrupted tools
// may still append results, and shutdown may flush a partial provider block.
function paused(id: string, value?: boolean): boolean {
	let path = `${paths.sessionDir(id)}/queue-edit.ason`
	let data = liveFiles.liveFile(path, { paused: false }, { watch: false })
	try {
		if (typeof data.paused !== 'boolean') throw new Error(`${path}: paused must be a boolean`)
		if (value !== undefined && value !== data.paused) { data.paused = value; liveFiles.save(data) }
		return data.paused
	} finally { liveFiles.close(data) }
}

function recover(id: string): void {
	if (!queueEdits.paused(id) || turns.state.running.has(id)) return
	if (status.stateOf(id).type !== 'paused') history.append(id, { type: 'turn_end', status: 'paused', usage: {} })
	status.state.states.set(id, { type: 'paused' })
}

type Hold = { owner: object; edit: string; message: string; resume: boolean; settling?: Promise<void> }

function refused(id: string): string | undefined {
	return queueEdits.state.has(id) ? 'a queued message is being edited; save or cancel the edit first' : undefined
}

function acquire(id: string, owner: object, edit: string, message: string): { refused?: string; reply?: Event } {
	if (forms.open(history.readSync(id))) return { refused: 'Answer or cancel the question before editing a queued message' }
	let held = queueEdits.state.get(id)
	if (held && (held.owner !== owner || held.edit !== edit || held.message !== message)) return { refused: queueEdits.refused(id) }
	let item = status.inboxOf(id).find((m) => m.id === message)
	if (!item?.queue || item.from !== undefined || item.origin === 'model') return { refused: 'that human message is no longer queued; it may already have been delivered' }
	if (!held) {
		let before = status.stateOf(id)
		let running = turns.state.running.get(id)
		held = { owner, edit, message, resume: states.busy(before), settling: running?.done }
		queueEdits.paused(id, true)
		queueEdits.state.set(id, held)
		if (states.busy(before)) {
			// Unlike Escape, acquisition must not skip or dismiss a question.
			let problem = status.transition(id, { type: 'pause' })
			if (problem) { queueEdits.state.delete(id); return { refused: problem } }
			running?.controller.abort()
			if (!running) history.append(id, { type: 'turn_end', status: 'paused', usage: {} })
		} else if (before.type !== 'paused') {
			// Idle/error sessions also need a durable pause, but no interrupted
			// turn is theirs to resume when the edit ends.
			history.append(id, { type: 'turn_end', status: 'paused', usage: {} })
			status.state.states.delete(id)
			host.broadcast(id, { type: 'state', sessionId: id, state: status.stateOf(id) })
		}
		host.broadcast(id, { type: 'queue-hold', sessionId: id, message })
	}
	return { reply: { type: 'queue-edit', sessionId: id, edit, message, text: item.text } }
}

function owns(id: string, owner: object, edit: string, message?: string): string | undefined {
	let held = queueEdits.state.get(id)
	return !held || held.owner !== owner || held.edit !== edit || (message !== undefined && held.message !== message) ? 'this connection does not own that queue edit; acquire it again' : undefined
}

function release(id: string, resume = true): void {
	let held = queueEdits.state.get(id)
	if (!held) return
	queueEdits.state.delete(id)
	host.broadcast(id, { type: 'queue-hold', sessionId: id })
	if (!resume || !held.resume) return
	queueEdits.pending.set(id, held)
	let go = () => {
		if (queueEdits.pending.get(id) !== held) return
		queueEdits.pending.delete(id)
		if (!held.resume || queueEdits.state.has(id) || status.stateOf(id).type !== 'paused') return
		let problem = prompts.resume(id)
		if (problem) host.broadcast(id, { type: 'warning', text: `queue edit ${id}: ${problem}` })
	}
	if (held.settling) void held.settling.then(go)
	else go()
}

function save(id: string, owner: object, edit: string, message: string, text: string, command?: string): string | undefined {
	let problem = queueEdits.owns(id, owner, edit, message)
	if (problem) return problem
	let item = status.inboxOf(id).find((m) => m.id === message)
	if (!item?.queue || item.from !== undefined || item.origin === 'model') return 'that human message is no longer queued'
	problem = prompts.edit(id, message, text, command, true)
	if (!problem) queueEdits.release(id)
	return problem
}

function cancel(id: string, owner: object, edit: string): string | undefined {
	let problem = queueEdits.owns(id, owner, edit)
	if (!problem) queueEdits.release(id)
	return problem
}

// Host entry points must guard before its special slash/rebase routing.
function repeated(owner: object, c: Command, refused?: string): void {
	if (refused !== undefined || c.type !== 'submit' || c.queueEdit === undefined) return
	if (!queueEdits.owns(c.sessionId, owner, c.queueEdit, c.edits)) queueEdits.release(c.sessionId)
}

function intercept(owner: object, c: Command): { refused?: string; reply?: Event } | undefined {
	if (!('sessionId' in c) || !c.sessionId) return
	let id = c.sessionId
	if (c.type === 'queue-edit') return queueEdits.acquire(id, owner, c.edit, c.message)
	if (c.type === 'queue-edit-cancel') return { refused: queueEdits.cancel(id, owner, c.edit) }
	if (c.type === 'submit' && c.queueEdit !== undefined) return { refused: queueEdits.save(id, owner, c.queueEdit, c.edits!, c.text, c.id) }
	if (!queueEdits.refused(id)) return
	if (c.type === 'rebase-apply') return { refused: queueEdits.refused(id) }
	if (c.type === 'submit') {
		let call = commands.parse(c.text)
		let allowed = !c.amend && c.rewind === undefined && (call ? call.name === 'pause' || call.name === 'close' || (call.name === 'queue' && !['next', 'clear'].includes(call.args)) : c.queue)
		if (!allowed) return { refused: queueEdits.refused(id) }
	}
}

function suppress(id?: string): void {
	for (let map of [queueEdits.state, queueEdits.pending]) for (let [key, held] of map) if (id === undefined || id === key) held.resume = false
}

function disconnect(owner: object, id?: string): void {
	for (let [key, held] of queueEdits.pending) if (held.owner === owner && (id === undefined || key === id)) held.resume = false
	for (let [key, held] of queueEdits.state) if (held.owner === owner && (id === undefined || key === id)) {
		queueEdits.release(key, false)
		host.broadcast(key, { type: 'warning', text: `Queue edit in ${key} disconnected; the message is unchanged and the session stays paused. Reacquire the message to keep editing.` })
	}
}

export const queueEdits = { state: new Map<string, Hold>(), pending: new Map<string, Hold>(), paused, recover, refused, acquire, owns, release, save, cancel, repeated, intercept, suppress, disconnect }
