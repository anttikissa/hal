// Queue-edit locks (task zez): editing a queued message locks that
// message only. The turn goes on; delivery stops at the locked message
// and the ones behind it, and save or cancel lets them go at once.
// The lock is in memory, owned by one connection: a disconnect or host
// restart releases it, leaving the message queued and unchanged.
// The host is single-threaded: acquire and every dequeue check and act
// synchronously, so exactly one of them wins.
// Tasks: rqq.
import type { Command, Event } from '../common/protocol.ts'
import { host } from './host.ts'
import { prompts } from './prompts.ts'
import { status } from './status.ts'
import { turns } from './turns.ts'

// `next`: /queue next was asked while the message was locked; it runs on release.
type Hold = { owner: object; edit: string; message: string; next?: true }

const busy = 'A queued message is being edited. Save or cancel the edit first.'

// The locked message's id, if any.
function held(id: string): string | undefined {
	return queueEdits.state.get(id)?.message
}

function acquire(id: string, owner: object, edit: string, message: string): { refused?: string; reply?: Event } {
	let hold = queueEdits.state.get(id)
	if (hold && (hold.edit !== edit || hold.message !== message)) return { refused: 'Another window is editing a queued message of this session.' }
	let item = status.inboxOf(id).find((m) => m.id === message)
	if (!(item?.delivery === 'after-turn') || item.from !== undefined || item.origin === 'model') return { refused: 'This message is no longer queued: it was already delivered.' }
	// The same edit from a new connection is its window reconnecting.
	if (hold) hold.owner = owner
	else {
		queueEdits.state.set(id, { owner, edit, message })
		host.broadcast(id, { type: 'queue-hold', sessionId: id, message })
	}
	return { reply: { type: 'queue-edit', sessionId: id, edit, message, text: item.text } }
}

function owns(id: string, owner: object, edit: string, message?: string): string | undefined {
	let hold = queueEdits.state.get(id)
	return !hold || hold.owner !== owner || hold.edit !== edit || (message !== undefined && hold.message !== message) ? 'This window is not editing that queued message; start the edit again.' : undefined
}

// Ends the lock; the message goes now if delivery waited for it.
function release(id: string): void {
	let hold = queueEdits.state.get(id)
	if (!hold) return
	queueEdits.state.delete(id)
	host.broadcast(id, { type: 'queue-hold', sessionId: id })
	if (hold.next) {
		let done = prompts.queueNext(id)
		if (done.error) host.broadcast(id, { type: 'warning', text: `/queue next in ${id}: ${done.error}` })
	} else if (!turns.state.running.has(id) && status.stateOf(id).type === 'idle') prompts.next(id)
}

function save(id: string, owner: object, edit: string, message: string, text: string, command?: string): string | undefined {
	let problem = queueEdits.owns(id, owner, edit, message) ?? prompts.edit(id, message, text, command, true)
	if (!problem) queueEdits.release(id)
	return problem
}

function cancel(id: string, owner: object, edit: string): string | undefined {
	let problem = queueEdits.owns(id, owner, edit)
	if (!problem) queueEdits.release(id)
	return problem
}

// A resent save that was already applied releases a lock its window took again.
function repeated(owner: object, c: Command, refused?: string): void {
	if (refused !== undefined || c.type !== 'submit' || c.queueEdit === undefined) return
	if (!queueEdits.owns(c.sessionId, owner, c.queueEdit, c.edits)) queueEdits.release(c.sessionId)
}

// Runs before the host's own routing. Only what would rewrite the
// waiting messages or history under the lock is refused.
function intercept(owner: object, c: Command): { refused?: string; reply?: Event } | undefined {
	if (!('sessionId' in c) || !c.sessionId) return
	let id = c.sessionId
	if (c.type === 'queue-edit') return queueEdits.acquire(id, owner, c.edit, c.message)
	if (c.type === 'queue-edit-cancel') return { refused: queueEdits.cancel(id, owner, c.edit) }
	if (c.type === 'submit' && c.queueEdit !== undefined) return { refused: queueEdits.save(id, owner, c.queueEdit, c.edits!, c.text, c.id) }
	if (!queueEdits.state.has(id)) return
	if (c.type === 'rebase-apply' || (c.type === 'submit' && c.rewind !== undefined)) return { refused: busy }
	if (c.type === 'submit' && c.edits === queueEdits.held(id)) return { refused: busy }
}

// Commands that would drop or rewrite waiting messages wait for the lock.
function refused(id: string, name: string, args = ''): string | undefined {
	if (!queueEdits.state.has(id)) return
	if (name === 'clear' || name === 'rebase' || (name === 'queue' && args === 'clear')) return busy
}

// /queue next on the locked message: it goes when the edit ends.
function deferNext(id: string): boolean {
	let hold = queueEdits.state.get(id)
	if (!hold || status.inboxOf(id).find((m) => m.delivery === 'after-turn')?.id !== hold.message) return false
	hold.next = true
	return true
}

function disconnect(owner: object, id?: string): void {
	for (let [key, hold] of queueEdits.state) if (hold.owner === owner && (id === undefined || key === id)) {
		host.broadcast(key, { type: 'warning', text: `The window editing a queued message in ${key} disconnected. The message is unchanged and stays in the queue.` })
		queueEdits.release(key)
	}
}

export const queueEdits = { state: new Map<string, Hold>(), held, acquire, owns, release, save, cancel, repeated, intercept, refused, deferNext, disconnect }
