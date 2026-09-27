// send: messages another session (task rj). The host, not the model,
// says who sent it: the calling session, by tab, id and name.
//
// Advisory by default: the recipient reads it before its next request
// but needn't drop its work; `steer` makes it steer as the user's
// messages do, `queue` runs it after the recipient's current turn. An
// idle recipient gets it as a turn of its own (prompts.submit).

import { existsSync } from 'fs'
import type { Sender } from '../../common/blocks.ts'
import { session } from '../../common/session.ts'
import { host } from '../host.ts'
import { paths } from '../paths.ts'
import { prompts } from '../prompts.ts'
import { tabs } from '../tabs.ts'
import type { Tool } from '../tools.ts'

// The session a tab number or id names, if it exists.
function target(to: string): string | undefined {
	if (/^\d+$/.test(to)) return tabs.file().open[Number(to) - 1]
	return session.isId(to) && existsSync(`${paths.sessionDir(to)}/session.ason`) ? to : undefined
}

export const tool: Tool = {
	name: 'send',
	description:
		'Send a message to another session, by tab number or session id. By default it is advisory: the recipient reads it soon ' +
		'but need not drop its work. steer: true steers it as the user would; queue: true runs it after its current turn.',
	parameters: {
		type: 'object',
		properties: {
			to: { type: 'string', description: 'Tab number or session id' },
			text: { type: 'string', description: 'The message' },
			steer: { type: 'boolean', description: 'Steer as the user would instead of advising' },
			queue: { type: 'boolean', description: "Run after the recipient's current turn" },
		},
		required: ['to', 'text'],
	},
	async run(input, ctx) {
		let { to, text, steer, queue } = input
		if (typeof to !== 'string' || !to.trim()) throw new Error('to must be a tab number or session id')
		if (typeof text !== 'string' || !text.trim()) throw new Error('text must be a non-empty string')
		for (let [k, v] of Object.entries({ steer, queue })) if (v !== undefined && typeof v !== 'boolean') throw new Error(`${k} must be a boolean`)
		if (steer && queue) throw new Error('steer and queue exclude each other')
		let id = target(to.trim())
		if (!id) throw new Error(`no session ${to}`)
		if (id === ctx.sessionId) throw new Error('cannot send to this session itself')
		await (host.ready(id) ?? Promise.resolve())
		let sender: Sender = { from: ctx.sessionId, label: tabs.label(ctx.sessionId) }
		if (!steer && !queue) sender.advisory = true
		let refused = prompts.submit(id, text, undefined, queue === true, sender)
		if (refused) throw new Error(refused)
		return `Sent to ${tabs.label(id)}`
	},
}
