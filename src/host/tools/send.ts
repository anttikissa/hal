// send: messages another session (task rj). The host, not the model,
// says who sent it: the calling session, by tab, id and name.
//
// `delivery` (task 760): soft-steer (default) reaches the recipient
// before its next request without interrupting work; emergency steers
// as a user message does; queue waits for its current turn to end. An
// idle recipient gets it as a turn of its own (prompts.submit). The
// result says which happened, including a message left waiting for the
// user because the recipient is paused, failed or blocked.

import { existsSync } from 'fs'
import type { Sender } from '../../common/blocks.ts'
import { session } from '../../common/session.ts'
import { host } from '../host.ts'
import { notify } from '../notify.ts'
import { paths } from '../paths.ts'
import { prompts } from '../prompts.ts'
import { status } from '../status.ts'
import { tabs } from '../tabs.ts'
import type { Tool } from '../tools.ts'

// The session a tab number or id names, if it exists.
function target(to: string): string | undefined {
	if (/^\d+$/.test(to)) return tabs.file().open[Number(to) - 1]
	return session.isId(to) && existsSync(`${paths.sessionDir(to)}/session.ason`) ? to : undefined
}

// What became of a message just submitted, for the sender.
function outcome(id: string, text: string, from: string, delivery: string): string {
	let to = tabs.label(id)
	let item = status.inboxOf(id).findLast((m) => m.from === from && m.text === text)
	if (!item) return `Sent to ${to}: it started a turn`
	let state = status.stateOf(id)
	if (item.queue && notify.asked(id)) return `Queued in ${to}: it waits for the user's answer, then reads this`
	let held = { paused: 'paused', error: 'failed', blocked: 'blocked' }[state.type as string]
	if (held) return `Waiting in ${to}: it is ${held}; it reads this when the user continues it`
	if (item.queue) return `Queued in ${to}: it reads this after its current turn`
	return delivery === 'emergency' ? `Interrupted ${to}: it reads this now` : `Sent to ${to}: it reads this before its next request`
}

export const tool: Tool = {
	name: 'send',
	description:
		'Send a message to another session, by tab number or session id. delivery: soft-steer (default) is read at its next round without interrupting its work; queue waits until its current turn ends; emergency interrupts its round at once (calls marked unsafe to stop finish first) — only for stopping harmful or wasted work. ' +
		'An idle recipient starts a turn. A paused, failed or blocked recipient keeps the message until the user continues it; one waiting for a human answer queues it. The result says which happened.',
	parameters: {
		type: 'object',
		properties: {
			to: { type: 'string', description: 'Tab number or session id' },
			text: { type: 'string', description: 'The message' },
			description: {
				type: 'string',
				description: 'One short plain-language sentence for the user: what the message says or asks, e.g. "Ask tab 2 to rerun the tests"',
			},
			delivery: { type: 'string', enum: ['soft-steer', 'queue', 'emergency'], description: 'Default soft-steer' },
		},
		required: ['to', 'text', 'description'],
	},
	async run(input, ctx) {
		let { to, text, description, delivery = 'soft-steer' } = input
		if (typeof to !== 'string' || !to.trim()) throw new Error('to must be a tab number or session id')
		if (typeof text !== 'string' || !text.trim()) throw new Error('text must be a non-empty string')
		if (typeof description !== 'string' || !description.trim()) throw new Error('description must be a non-empty string')
		// LEGACY-SEND (task zb0): delete with its test by 2026-10-10.
		if ('steer' in input || 'queue' in input) throw new Error("steer and queue are no longer parameters: use delivery 'emergency' or 'queue'")
		if (delivery !== 'soft-steer' && delivery !== 'queue' && delivery !== 'emergency') throw new Error('delivery must be soft-steer, queue or emergency')
		let id = target(to.trim())
		if (!id) throw new Error(`no session ${to}`)
		if (id === ctx.sessionId) throw new Error('cannot send to this session itself')
		await (host.ready(id) ?? Promise.resolve())
		let sender: Sender = { from: ctx.sessionId, label: tabs.label(ctx.sessionId), summary: description.replace(/\s+/g, ' ').trim() }
		if (delivery === 'soft-steer') sender.advisory = true
		let refused = prompts.submit(id, text, undefined, delivery === 'queue' ? 'queue' : 'steer', sender)
		if (refused) throw new Error(refused)
		return outcome(id, text, ctx.sessionId, delivery)
	},
}
