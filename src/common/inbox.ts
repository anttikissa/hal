// The session inbox (tasks/j1/states.md, Talking while it works):
// messages the user sent while a turn was busy, durable in history as
// `inbox` records until a prompt record delivers them (its `inbox` ids).
// A steering message goes to the model before the turn's next request; a
// queued one (`queue`) runs as a turn of its own after the turn ends.
// Not a state: every client shows the inbox beside any state, each
// message saying why it waits.

import type { HistoryRecord } from './replay.ts'
import { states, type SessionState } from './states.ts'

export type InboxItem = { id: string; text: string; queue?: true }

// Messages sent and not yet delivered, oldest first.
function pending(records: HistoryRecord[]): InboxItem[] {
	let waiting = new Map<string, InboxItem>()
	for (let r of records) {
		if (r.type === 'inbox') waiting.set(r.id, r.queue ? { id: r.id, text: r.text, queue: true } : { id: r.id, text: r.text })
		else if (r.type === 'user') for (let id of r.inbox ?? []) waiting.delete(id)
	}
	return [...waiting.values()]
}

// Why the message waits and what ends the wait, in a few words.
function label(state: SessionState, item: InboxItem): string {
	if (state.type === 'running') return item.queue ? 'queued: runs after this turn' : 'steering: sent before the next request'
	if (state.type === 'idle') return 'waiting'
	let kind = item.queue ? 'queued' : 'steering'
	let why = states.describe(state)
	return why ? `${kind}, waiting: ${why}` : `${kind}, waiting for an answer`
}

export const inbox = { pending, label }
