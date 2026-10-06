// The session inbox (tasks/j1/states.md, Talking while it works):
// messages the user sent while a turn was busy, durable in history as
// `inbox` records until a prompt record delivers them (its `inbox` ids).
// Interrupt delivery reaches the model before the turn's next round;
// after-this-turn delivery (`queue`) starts a turn after the current one ends.
// Not a state: every client shows these as normal prompt cards, with
// sender and delivery in the header; why it waits belongs to the status.

import type { Sender } from './blocks.ts'
import type { HistoryRecord } from './replay.ts'
import { titles } from './titles.ts'

// Sender fields: another session sent it (task rj); none, the human.
// `ts`: when it was first written to the inbox.
// n: the history line of the inbox record that first sent it.
export type InboxItem = { id: string; text: string; queue?: true; ts?: string; n?: number } & Sender

// Messages sent and not yet delivered, as last edited, in delivery
// order: those read at the next round, then queued ones; each oldest first.
function pending(records: HistoryRecord[]): InboxItem[] {
	let waiting = new Map<string, InboxItem>()
	for (let r of records) {
		if (r.type === 'inbox' && r.withdrawn) waiting.delete(r.id)
		else if (r.type === 'inbox') {
			// An edit keeps the message's place: Map.set on a key keeps its order.
			let first = waiting.get(r.id)
			let item: InboxItem = { id: r.id, text: r.text, ts: first?.ts ?? r.ts }
			let n = first ? first.n : r.n
			if (n !== undefined) item.n = n
			if (r.queue) item.queue = true
			Object.assign(item, inbox.sender(r))
			waiting.set(r.id, item)
		}
		else if (r.type === 'user') for (let id of r.inbox ?? []) waiting.delete(id)
	}
	let all = [...waiting.values()]
	return [...all.filter((m) => !m.queue), ...all.filter((m) => m.queue)]
}

// The sender fields of a record or item, and nothing else.
function sender(s: Sender): Sender {
	let out: Sender = {}
	if (s.queuedAt !== undefined) out.queuedAt = s.queuedAt
	if (s.origin !== undefined) out.origin = s.origin
	if (s.generatingCommand !== undefined) out.generatingCommand = s.generatingCommand
	if (s.from !== undefined) out.from = s.from
	if (s.label !== undefined) out.label = s.label
	if (s.advisory) out.advisory = true
	if (s.steering) out.steering = true
	if (s.summary) out.summary = s.summary
	return out
}

// Provenance a waiting message retains when delivered. Next-round and
// after-this-turn messages do not interrupt; delivery belongs to each text.
function provenance(item: InboxItem): Sender {
	return { ...inbox.sender(item), ...(item.queue && item.ts !== undefined ? { queuedAt: item.ts } : {}), ...(!item.queue && !item.advisory ? { steering: true as const } : {}) }
}

// What leads a waiting message's compact row (task 16):
// '15:29 Message from 76-cpo, tab 5 (queued)'.
// `tab`: the sender's current tab number, if it
// has one. Not the label: it already names the tab it had when sending. Never why the session stalls: that is the status line.
function note(item: InboxItem, tab?: number): string {
	let who = item.from === undefined ? 'You' : `Message from ${item.from}${tab === undefined ? '' : `, tab ${tab}`}`
	return titles.stamp(item.ts, `${who} (queued)`)
}

export const inbox = { pending, sender, provenance, note }
