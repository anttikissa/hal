// A structured mid-turn notice; it does not finish or interrupt the turn.
import { host } from '../host.ts'
import { notify } from '../notify.ts'
import type { Tool, ToolContext } from '../tools.ts'

// Configuration: true puts the whole help in the system prompt; false
// lists only the summary under Other tools (HELP <TOOL> shows the rest).
const inPrompt = false
const summary = 'user'
const help = `## NOTIFY

Post a notice to the user during this turn, for example when an approach fails. The turn continues.
NOTIFY "<text>"    // one line under 80 characters`

const parameters = {
	type: 'object',
	properties: { text: { type: 'string', maxLength: 79 } },
	required: ['text'],
	additionalProperties: false,
}

const syntax = { usage: ['NOTIFY "<text>"'], block: 'text' }

// Advertises under 80 characters, accepts up to 100 (task gtw).
async function run(input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
	if (
		typeof input.text !== 'string' ||
		!input.text.trim() ||
		[...input.text].length > 100 ||
		/[\r\n\p{Cc}]/u.test(input.text)
	)
		throw new Error(
			`text must be one non-empty line under 80 characters${typeof input.text === 'string' ? `; got ${[...input.text].length}` : ''}`,
		)
	if (Object.keys(input).some((k) => k !== 'text')) throw new Error('notify accepts only text')
	if (ctx.signal.aborted) throw new Error('canceled; notice not sent')
	notify.deliver(host.state.clients, ctx.sessionId, 'update', input.text, input.text)
	return 'sent'
}

export const tool: Tool = { name: 'notify', inPrompt, summary, help, parameters, syntax, run }
