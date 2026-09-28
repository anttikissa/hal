// /queue manages durable prompts waiting for their own turns.
import { states } from '../../common/states.ts'
import type { SlashCommand } from '../commands.ts'
import { history } from '../history.ts'
import { host } from '../host.ts'
import { prompts } from '../prompts.ts'
import { status } from '../status.ts'

export const command: SlashCommand = {
	help: () => '/queue <prompt>: queue a prompt like Alt-Enter. /queue lists queued prompts; /queue next runs the oldest now; /queue clear drops them all.',
	run(args, _answers, ctx) {
		let id = ctx.sessionId
		let queued = status.inboxOf(id).filter((m) => m.queue)
		if (!args) return { say: queued.length ? queued.map((m, i) => `${i + 1}. ${m.text}`).join('\n') : 'queue is empty' }
		if (args === 'clear') {
			for (let item of queued) history.append(id, { type: 'inbox', id: item.id, text: item.text, withdrawn: true })
			if (queued.length) host.broadcast(id, { type: 'inbox', sessionId: id, inbox: status.inboxOf(id) })
			return { say: `cleared ${queued.length} queued prompt${queued.length === 1 ? '' : 's'}` }
		}
		if (args === 'next') {
			let item = queued[0]
			if (!item) return { say: 'queue is empty' }
			if (states.busy(status.stateOf(id))) {
				// Editing this inbox id preserves its place, sender and provenance.
				history.append(id, { type: 'inbox', id: item.id, text: item.text, ...('from' in item && item.from ? { from: item.from, label: item.label } : {}) })
				host.broadcast(id, { type: 'inbox', sessionId: id, inbox: status.inboxOf(id) })
				return { say: 'next queued prompt will steer this turn' }
			}
			// With no turn running, remove its old copy before starting a turn.
			history.append(id, { type: 'inbox', id: item.id, text: item.text, withdrawn: true })
			host.broadcast(id, { type: 'inbox', sessionId: id, inbox: status.inboxOf(id) })
			let refused = prompts.submit(id, item.text, undefined, false, item.from ? { from: item.from, label: item.label } : undefined)
			return refused ? { error: refused } : { say: 'running next queued prompt' }
		}
		let refused = prompts.submit(id, args, undefined, true)
		return refused ? { error: refused } : { say: 'queued prompt' }
	},
}
