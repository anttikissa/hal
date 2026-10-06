// /queue manages durable queued messages.
import { states } from '../../common/states.ts'
import type { SlashCommand } from '../commands.ts'
import { history } from '../history.ts'
import { host } from '../host.ts'
import { queueEdits } from '../queue-edits.ts'
import { prompts } from '../prompts.ts'
import { status } from '../status.ts'
import { turns } from '../turns.ts'

export const command: SlashCommand = {
	help: () => '/queue <message>: queue a message, like Alt-Enter. /queue lists queued messages; /queue next sends the oldest now, steering a running turn; /queue clear drops them all.',
	run(args, _answers, ctx) {
		let id = ctx.sessionId
		let queued = status.inboxOf(id).filter((m) => m.queue)
		if (!args) return { say: queued.length ? queued.map((m, i) => `${i + 1}. ${m.text}`).join('\n') : 'queue is empty' }
		if ((args === 'clear' || args === 'next') && queueEdits.refused(id)) return { error: queueEdits.refused(id) }
		if (args === 'clear') {
			for (let item of queued) history.append(id, { type: 'inbox', id: item.id, text: item.text, withdrawn: true })
			if (queued.length) host.broadcast(id, { type: 'inbox', sessionId: id, inbox: status.inboxOf(id) })
			return { say: `cleared ${queued.length} queued message${queued.length === 1 ? '' : 's'}` }
		}
		if (args === 'next') {
			let item = queued[0]
			if (!item) return { say: 'queue is empty' }
			if (states.busy(status.stateOf(id))) {
				// Editing this inbox id preserves its place, sender and provenance.
				history.append(id, { type: 'inbox', id: item.id, text: item.text, ...('from' in item && item.from ? { from: item.from, label: item.label } : {}) })
				host.broadcast(id, { type: 'inbox', sessionId: id, inbox: status.inboxOf(id) })
				return { say: 'sending the next queued message now' }
			}
			// Deliver the existing inbox id as a fresh turn, even if paused.
			let refused = status.transition(id, { type: 'submit' })
			if (refused) return { error: refused }
			let record = prompts.deliver(id, [item], undefined, undefined, true)
			turns.start(id, prompts.texts(record.blocks)[0], undefined, prompts.images(record.blocks), { ...record, sender: prompts.senders(record.blocks)[0] })
			return { say: 'running the next queued message' }
		}
		let refused = prompts.submit(id, args, undefined, true)
		return refused ? { error: refused } : { say: 'queued' }
	},
}
