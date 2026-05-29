// Send tool — send a message to another Hal session's inbox.
//
// Drops an .ason file into state/inbox/<target-session-id>/ which
// the inbox handler picks up and feeds into the agent loop.

import { toolRegistry, type Tool, type ToolContext } from './tool.ts'
import { ipc } from '../ipc.ts'
import { inbox } from '../runtime/inbox.ts'

interface SendInput {
	sessionId?: string
	text?: string
	queue?: boolean
}

function normalizeInput(input: unknown): SendInput {
	const raw = toolRegistry.inputObject(input)
	return {
		sessionId: raw.sessionId === undefined ? undefined : String(raw.sessionId),
		text: raw.text === undefined ? undefined : String(raw.text),
		queue: raw.queue === true,
	}
}

function targetTab(sessionId: string): number | undefined {
	const session = ipc.readState().sessions.find((item) => item.id === sessionId)
	const tab = session?.tab
	if (!Number.isFinite(tab)) return undefined
	return Math.floor(tab as number)
}

function resultText(targetId: string, queued: boolean): string {
	const tab = targetTab(targetId)
	const action = queued ? 'Queued message for' : 'Sent message to'
	if (tab) return `${action} tab ${tab} (${targetId})`
	return `${action} session ${targetId}`
}

async function execute(input: unknown, ctx: ToolContext): Promise<string> {
	const spec = normalizeInput(input)
	const targetId = spec.sessionId ?? ''
	const text = spec.text ?? ''

	if (!targetId) return 'error: sessionId is required'
	if (!text) return 'error: text is required'
	if (targetId === ctx.sessionId) return 'error: cannot send to own session'

	try {
		inbox.queueMessage(targetId, text, ctx.sessionId, spec.queue)
		return resultText(targetId, !!spec.queue)
	} catch (err: unknown) {
		return `error: ${toolRegistry.errorMessage(err)}`
	}
}

const sendTool: Tool = {
	name: 'send',
	description:
		'Send a message to another session. By default this behaves like a prompt and steers if the target is working; set queue=true to run it after the current turn.',
	parameters: {
		sessionId: { type: 'string', description: 'Target session ID (or "all" for broadcast)' },
		text: { type: 'string', description: 'Message text' },
		queue: { type: 'boolean', description: 'Queue instead of steering if the target session is working' },
	},
	required: ['sessionId', 'text'],
	execute,
}

function init(): void {
	toolRegistry.registerTool(sendTool)
}

export const send = { execute, init, resultText, targetTab }
