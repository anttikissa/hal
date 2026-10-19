// /queue next and /queue undo: moving the oldest queued message ahead
// of its turn, and putting it back (task csn).
import { inbox } from '../common/inbox.ts'
import { states } from '../common/states.ts'
import { history } from './history.ts'
import { host } from './host.ts'
import { prompts } from './prompts.ts'
import { queueEdits } from './queue-edits.ts'
import { status } from './status.ts'
import { turns } from './turns.ts'

// /queue next: the oldest queued message goes now. In a busy turn it
// interjects at the next round (`now`: interrupts, task csn); otherwise
// it runs as a fresh turn, even if paused. One being edited goes when
// the edit ends.
function send(id: string, now = false, pick?: string): { say?: string; error?: string } {
	let item = status.inboxOf(id).find((m) => m.delivery === 'after-turn' && (pick === undefined || m.id === pick))
	if (!item) return { say: 'queue is empty' }
	if (pick !== undefined && pick === queueEdits.held(id))
		return { error: 'That message is being edited; save or cancel the edit first.' }
	if (pick === undefined && queueEdits.deferNext(id))
		return { say: 'The next queued message is being edited. It is sent when the edit is saved or canceled.' }
	if (states.busy(status.stateOf(id))) {
		// Editing this inbox id preserves its place, sender and provenance.
		history.append(id, {
			type: 'inbox',
			id: item.id,
			text: item.text,
			...inbox.provenance(item),
			delivery: now ? 'now' : 'next-round',
		})
		host.broadcast(id, { type: 'inbox', sessionId: id, inbox: status.inboxOf(id) })
		let running = turns.state.running.get(id)
		if (!now) queueNext.promoted.set(id, item.id)
		else if (running) {
			queueNext.promoted.delete(id)
			status.transition(id, { type: 'submit' })
			prompts.force(running)
		}
		return {
			say: now ? 'interrupting with the next queued message' : 'sending the next queued message at the next round',
		}
	}
	let refused = status.transition(id, { type: 'submit' })
	if (refused) return { error: refused }
	let record = prompts.deliver(id, [item], undefined, undefined, true)
	turns.start(id, prompts.texts(record.blocks)[0], undefined, prompts.images(record.blocks), {
		...record,
		sender: prompts.senders(record.blocks)[0],
	})
	return { say: 'running the next queued message' }
}

// /queue undo: the message /queue next last moved goes back to the
// front of the queue, if the turn has not read it yet (task csn).
function undo(id: string): { say?: string; error?: string } {
	let item = status.inboxOf(id).find((m) => m.id === queueNext.promoted.get(id) && m.delivery !== 'after-turn')
	queueNext.promoted.delete(id)
	if (!item) return { error: 'Nothing to undo: no message was sent early, or the turn already read it.' }
	history.append(id, { type: 'inbox', id: item.id, text: item.text, ...inbox.sender(item), delivery: 'after-turn' })
	host.broadcast(id, { type: 'inbox', sessionId: id, inbox: status.inboxOf(id) })
	return { say: 'queued again' }
}

export const queueNext = {
	send,
	undo,
	// By session: the inbox id /queue next last moved, for /queue undo.
	promoted: new Map<string, string>(),
}
