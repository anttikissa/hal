import { toolRegistry, type Tool, type ToolContext } from './tool.ts'
import { agentLoop } from '../runtime/agent-loop.ts'
import { sessionLabel } from '../../common/session-label.ts'

async function execute(_input: unknown, ctx: ToolContext): Promise<string> {
	const active = agentLoop.runningSubagents(ctx.sessionId)
	if (active.length === 0) return 'Waiting for the next subagent.'
	return `Waiting for the next subagent. Active: ${active.map(sessionLabel.format).join(', ')}`
}

const waitTool: Tool = {
	name: 'wait',
	description: 'Wait for the next subagent to finish. Ends the current turn; the subagent’s inbox message will start a new turn when it arrives.',
	parameters: {},
	execute,
}

function init(): void {
	toolRegistry.registerTool(waitTool)
}

export const wait = { execute, init }
