// /queue manages durable queued messages.
// Tasks: jq, gr4, rqq.
import { sendKeys } from '../../common/send-keys.ts'
import type { SlashCommand } from '../commands.ts'
import { history } from '../history.ts'
import { host } from '../host.ts'
import { prompts } from '../prompts.ts'
import { queueEdits } from '../queue-edits.ts'
import { status } from '../status.ts'

const queuedOf = (id: string) => status.inboxOf(id).filter((m) => m.delivery === 'after-turn')

// The message `/queue drop <key>` names: its position in /queue's list,
// or its inbox id (the web's × sends it, so a queue that changed in
// between cannot shift the target).
function target(id: string, key: string): { n: number; item?: { id: string; text: string } } {
	let queued = queuedOf(id)
	let n = /^\d+$/.test(key) ? Number(key) : queued.findIndex((m) => m.id === key) + 1
	return { n, item: n > 0 ? queued[n - 1] : undefined }
}

export const command: SlashCommand = {
	help: () => `/queue <message>: queue a message, like ${sendKeys.name('queue')}. /queue lists queued messages; /queue next soft-steers a running turn with the oldest (${sendKeys.name('soft-steer')} on an empty prompt), /queue now steers with it (${sendKeys.name('steer')}), /queue undo queues it again if still waiting (Cmd-Z on an empty prompt); /queue drop <n> drops the nth message in the list; /queue clear drops them all.`,
	record(args, id) {
		let key = args.match(/^drop\s+(\S+)$/)?.[1]
		let n = key === undefined ? 0 : target(id, key).n
		return n > 0 ? `/queue drop ${n}` : undefined
	},
	run(args, _answers, ctx) {
		let id = ctx.sessionId
		let queued = queuedOf(id)
		if (!args) return { say: queued.length ? queued.map((m, i) => `${i + 1}. ${m.text}`).join('\n') : 'queue is empty' }
		if (args === 'clear') {
			for (let item of queued) history.append(id, { type: 'inbox', id: item.id, text: item.text, withdrawn: true })
			if (queued.length) host.broadcast(id, { type: 'inbox', sessionId: id, inbox: status.inboxOf(id) })
			return { say: `cleared ${queued.length} queued message${queued.length === 1 ? '' : 's'}` }
		}
		let drop = args.match(/^drop(?:\s+(\S+))?$/)
		if (drop) {
			if (!drop[1]) return { error: 'Say which message to drop: /queue drop <n>, where n is its number in /queue.' }
			let { n, item } = target(id, drop[1])
			if (!item) return { error: /^\d+$/.test(drop[1]) ? `There is no queued message ${drop[1]}. The queue has ${queued.length}.` : 'That message is no longer queued: it was already delivered or dropped.' }
			if (item.id === queueEdits.held(id)) return { error: 'That message is being edited; save or cancel the edit first.' }
			// The durable withdrawal /queue clear uses; the others keep their order.
			history.append(id, { type: 'inbox', id: item.id, text: item.text, withdrawn: true })
			host.broadcast(id, { type: 'inbox', sessionId: id, inbox: status.inboxOf(id) })
			return { say: `dropped queued message ${n}: ${item.text}` }
		}
		if (args === 'next' || args === 'now') return prompts.queueNext(id, args === 'now')
		if (args === 'undo') return prompts.unqueueUndo(id)
		let refused = prompts.submit(id, args, undefined, 'queue')
		return refused ? { error: refused } : { say: 'queued' }
	},
}
