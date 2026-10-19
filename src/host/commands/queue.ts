// /queue manages durable queued messages.
// Tasks: jq, gr4, rqq.
import { sendKeys } from '../../common/send-keys.ts'
import type { SlashCommand } from '../commands.ts'
import { history } from '../history.ts'
import { host } from '../host.ts'
import { prompts } from '../prompts.ts'
import { queueEdits } from '../queue-edits.ts'
import { queueNext } from '../queue-next.ts'
import { status } from '../status.ts'

const queuedOf = (id: string) => status.inboxOf(id).filter((m) => m.delivery === 'after-turn')

// The web's × names an inbox id explicitly, so a queue that changed in
// between cannot shift the target. Other text after /queue is a prompt.
const dropPattern = /^drop\s+(?:(\d+)|--id\s+(\S+))$/
function target(id: string, key: string, byId = false): { n: number; item?: { id: string; text: string } } {
	let queued = queuedOf(id)
	let n = !byId && /^\d+$/.test(key) ? Number(key) : queued.findIndex((m) => m.id === key) + 1
	return { n, item: n > 0 ? queued[n - 1] : undefined }
}

export const command: SlashCommand = {
	help: () =>
		[
			'/queue lists queued messages.',
			`/queue <message> queues a message, like ${sendKeys.name('queue')}.`,
			`/queue next [n] soft-steers a running turn with the oldest or nth message, or runs it when idle (${sendKeys.name('soft-steer')} on an empty prompt).`,
			`/queue now [n] steers with the oldest or nth message (${sendKeys.name('steer')}).`,
			'/queue undo queues the message /queue next moved again, if the turn has not read it (Cmd-Z on an empty prompt).',
			'/queue drop <n> drops the nth message in the list.',
			'/queue clear drops all queued messages.',
		].join('\n'),
	record(args, id) {
		let drop = args.match(dropPattern)
		if (drop) {
			let { n } = target(id, (drop[1] ?? drop[2])!, drop[2] !== undefined)
			return n > 0 ? `/queue drop ${n}` : undefined
		}
		let m = args.match(/^(next|now)\s+(\S+)$/)
		let n = m ? target(id, m[2]!).n : 0
		return n > 0 ? `/queue ${m![1]} ${n}` : undefined
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
		let drop = args.match(dropPattern)
		if (drop) {
			let key = (drop[1] ?? drop[2])!
			let { n, item } = target(id, key, drop[2] !== undefined)
			if (!item)
				return {
					error:
						drop[1] !== undefined
							? `There is no queued message ${key}. The queue has ${queued.length}.`
							: 'That message is no longer queued: it was already delivered or dropped.',
				}
			if (item.id === queueEdits.held(id))
				return { error: 'That message is being edited; save or cancel the edit first.' }
			// The durable withdrawal /queue clear uses; the others keep their order.
			history.append(id, { type: 'inbox', id: item.id, text: item.text, withdrawn: true })
			host.broadcast(id, { type: 'inbox', sessionId: id, inbox: status.inboxOf(id) })
			return { say: `dropped queued message ${n}: ${item.text}` }
		}
		let early = args.match(/^(next|now)(?:\s+(\S+))?$/)
		if (early) {
			let item = early[2] === undefined ? undefined : target(id, early[2]).item
			if (early[2] !== undefined && !item)
				return { error: 'That message is no longer queued: it was already delivered or dropped.' }
			return queueNext.send(id, early[1] === 'now', item?.id)
		}
		if (args === 'undo') return queueNext.undo(id)
		let refused = prompts.submit(id, args, undefined, 'queue')
		return refused ? { error: refused } : { say: 'queued' }
	},
}
