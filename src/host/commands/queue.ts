// /queue manages durable queued messages.
import type { SlashCommand } from '../commands.ts'
import { history } from '../history.ts'
import { host } from '../host.ts'
import { prompts } from '../prompts.ts'
import { status } from '../status.ts'

export const command: SlashCommand = {
	help: () => '/queue <message>: queue a message, like Alt-Enter. /queue lists queued messages; /queue next sends the oldest now, steering a running turn; /queue clear drops them all.',
	run(args, _answers, ctx) {
		let id = ctx.sessionId
		let queued = status.inboxOf(id).filter((m) => m.queue)
		if (!args) return { say: queued.length ? queued.map((m, i) => `${i + 1}. ${m.text}`).join('\n') : 'queue is empty' }
		if (args === 'clear') {
			for (let item of queued) history.append(id, { type: 'inbox', id: item.id, text: item.text, withdrawn: true })
			if (queued.length) host.broadcast(id, { type: 'inbox', sessionId: id, inbox: status.inboxOf(id) })
			return { say: `cleared ${queued.length} queued message${queued.length === 1 ? '' : 's'}` }
		}
		if (args === 'next') return prompts.queueNext(id)
		let refused = prompts.submit(id, args, undefined, true)
		return refused ? { error: refused } : { say: 'queued' }
	},
}
