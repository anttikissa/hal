// A structured mid-turn notice; it does not finish or interrupt the turn.
import { host } from '../host.ts'
import { notify } from '../notify.ts'
import type { Tool } from '../tools.ts'

export const tool: Tool = {
	name: 'notify',
	description: 'Post a notice to the user during this turn, for example when an approach fails. Use one line under 80 characters. The turn continues.',
	parameters: { type: 'object', properties: { text: { type: 'string', maxLength: 79, description: 'One line saying what happened' } }, required: ['text'], additionalProperties: false },
	async run(input, ctx) {
		if (typeof input.text !== 'string' || !input.text.trim() || [...input.text].length >= 80 || /[\r\n\p{Cc}]/u.test(input.text)) throw new Error('text must be one non-empty line under 80 characters')
		if (Object.keys(input).some((k) => k !== 'text')) throw new Error('notify accepts only text')
		if (ctx.signal.aborted) throw new Error('cancelled; notice not sent')
		notify.deliver(host.state.clients, ctx.sessionId, 'update', input.text, input.text)
		return 'sent'
	},
}
