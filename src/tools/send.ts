// Send tool — send a message to another Hal session's inbox.
//
// Drops an .ason file into state/inbox/<target-session-id>/ which
// the inbox handler picks up and feeds into the agent loop.

import { toolRegistry, type Tool, type ToolContext } from './tool.ts'
import { inbox } from '../runtime/inbox.ts'

interface SendInput {
	sessionId?: string
	text?: string
}

function normalizeInput(input: unknown): SendInput {
	const raw = toolRegistry.inputObject(input)
	return {
		sessionId: raw.sessionId === undefined ? undefined : String(raw.sessionId),
		text: raw.text === undefined ? undefined : String(raw.text),
	}
}

async function execute(input: unknown, ctx: ToolContext): Promise<string> {
	const spec = normalizeInput(input)
	const targetId = spec.sessionId ?? ''
	const text = spec.text ?? ''

	if (!targetId) return 'error: sessionId is required'
	if (!text) return 'error: text is required'
	if (targetId === ctx.sessionId) return 'error: cannot send to own session'

	try {
		inbox.queueMessage(targetId, text, ctx.sessionId)
		return `Sent message to session ${targetId}`
	} catch (err: unknown) {
		return `error: ${toolRegistry.errorMessage(err)}`
	}
}

const sendTool: Tool = {
	name: 'send',
	description:
		"Send a message to another session's inbox. The message will be processed as a prompt (if idle) or queued (if busy).",
	parameters: {
		sessionId: { type: 'string', description: 'Target session ID (or "all" for broadcast)' },
		text: { type: 'string', description: 'Message text' },
	},
	required: ['sessionId', 'text'],
	execute,
}

function init(): void {
	toolRegistry.registerTool(sendTool)
}

export const send = { execute, init }
