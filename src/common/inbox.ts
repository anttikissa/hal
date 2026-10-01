// The session inbox (tasks/j1/states.md, Talking while it works):
// messages the user sent while a turn was busy, durable in history as
// `inbox` records until a prompt record delivers them (its `inbox` ids).
// A steering message goes to the model before the turn's next request; a
// queued one (`queue`) runs as a turn of its own after the turn ends.
// Not a state: every client shows these as normal prompt cards, with
// sender and kind in the header; why it waits belongs to the status.

import type { Sender } from './blocks.ts'
import type { HistoryRecord } from './replay.ts'
import { titles } from './titles.ts'

// Sender fields: another session sent it (task rj); none, the human.
// `ts`: when it was first written to the inbox.
export type InboxItem = { id: string; text: string; queue?: true; ts?: string } & Sender

// Messages sent and not yet delivered, oldest first, as last edited.
function pending(records: HistoryRecord[]): InboxItem[] {
	let waiting = new Map<string, InboxItem>()
	for (let r of records) {
		if (r.type === 'inbox' && r.withdrawn) waiting.delete(r.id)
		else if (r.type === 'inbox') {
			// An edit keeps the message's place: Map.set on a key keeps its order.
			let item: InboxItem = { id: r.id, text: r.text, ts: waiting.get(r.id)?.ts ?? r.ts }
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
	if (s.steering) out.steering = true
	if (s.summary) out.summary = s.summary
	return out
}

// Provenance a waiting message retains when delivered. Queue and
// advisory messages are not steering; the kind belongs to each text.
function provenance(item: InboxItem): Sender {
	return { ...inbox.sender(item), ...(!item.queue && !item.advisory ? { steering: true as const } : {}) }
}

// What leads a queued message's compact row (task 16): '(Queued at
// 15:29 by 76-cpo, tab 5)'. `tab`: the sender's tab number, if it has
// one. Never why the session stalls: that is the status line.
function note(item: InboxItem, tab?: number): string {
	let at = titles.time(item.ts)
	let by = item.from === undefined ? '' : ` by ${item.label ?? item.from}${tab === undefined ? '' : `, tab ${tab}`}`
	return `(Queued${at ? ` at ${at}` : ''}${by})`
}

export const inbox = { pending, sender, provenance, note }
