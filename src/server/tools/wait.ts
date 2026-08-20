import { toolRegistry, type Tool } from './tool.ts'

async function execute(): Promise<string> {
	return 'Waiting for the next subagent.'
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
