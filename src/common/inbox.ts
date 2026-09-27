// The session inbox (tasks/j1/states.md, Talking while it works):
// messages the user sent while a turn was busy, durable in history as
// `inbox` records until a prompt record delivers them (its `inbox` ids).
// A steering message goes to the model before the turn's next request; a
// queued one (`queue`) runs as a turn of its own after the turn ends.
// Not a state: every client shows the inbox beside any state, each
// message saying why it waits.

import type { Sender } from './blocks.ts'
import type { HistoryRecord } from './replay.ts'
import { states, type SessionState } from './states.ts'

// Sender fields: another session sent it (task rj); none, the human.
export type InboxItem = { id: string; text: string; queue?: true } & Sender

// Messages sent and not yet delivered, oldest first, as last edited.
function pending(records: HistoryRecord[]): InboxItem[] {
	let waiting = new Map<string, InboxItem>()
	for (let r of records) {
		if (r.type === 'inbox' && r.withdrawn) waiting.delete(r.id)
		else if (r.type === 'inbox') {
			// An edit keeps the message's place: Map.set on a key keeps its order.
			let item: InboxItem = { id: r.id, text: r.text }
			if (r.queue) item.queue = true
			Object.assign(item, inbox.sender(r))
			waiting.set(r.id, item)
		}
		else if (r.type === 'user') for (let id of r.inbox ?? []) waiting.delete(id)
	}
	return [...waiting.values()]
}

// The sender fields of a record or item, and nothing else.
function sender(s: Sender): Sender {
	let out: Sender = {}
	if (s.from !== undefined) out.from = s.from
	if (s.label !== undefined) out.label = s.label
	if (s.advisory) out.advisory = true
	return out
}

// Why the message waits and what ends the wait, in a few words, and
// who sent it if not the human.
function label(state: SessionState, item: InboxItem): string {
	let by = item.from === undefined ? '' : ` (from ${item.label ?? item.from})`
	let kind = item.queue ? 'queued' : item.advisory ? 'advisory' : 'steering'
	if (state.type === 'running') return (item.queue ? 'queued: runs after this turn' : `${kind}: sent before the next request`) + by
	if (state.type === 'idle') return `waiting${by}`
	let why = states.describe(state)
	return (why ? `${kind}, waiting: ${why}` : `${kind}, waiting for an answer`) + by
}

export const inbox = { pending, sender, label }
