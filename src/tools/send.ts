// Send tool — send a message to another Hal session's inbox.
//
// Drops an .ason file into state/inbox/<target-session-id>/ which
// the inbox handler picks up and feeds into the agent loop.

import { toolRegistry, type ToolContext } from './tool.ts'
import { inbox } from '../runtime/inbox.ts'

async function execute(input: any, ctx: ToolContext): Promise<string> {
	const targetId = String(input?.sessionId ?? '')
	const text = String(input?.text ?? '')

	if (!targetId) return 'error: sessionId is required'
	if (!text) return 'error: text is required'
	if (targetId === ctx.sessionId) return 'error: cannot send to own session'

	try {
		inbox.queueMessage(targetId, text, ctx.sessionId)
		return `Sent message to session ${targetId}`
	} catch (err: any) {
		return `error: ${err?.message ?? String(err)}`
	}
}

toolRegistry.registerTool({
	name: 'send',
	description:
		"Send a message to another session's inbox. The message will be processed as a prompt (if idle) or queued (if busy).",
	parameters: {
		sessionId: { type: 'string', description: 'Target session ID (or "all" for broadcast)' },
		text: { type: 'string', description: 'Message text' },
	},
	required: ['sessionId', 'text'],
	execute,
})

export const send = { execute }
