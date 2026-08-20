import { expect, test } from 'bun:test'
import { builtins } from './builtins.ts'
import { toolRegistry } from './tool.ts'

toolRegistry.clearForTests()
builtins.state.initialized = false
test('builtins.init registers tools lazily and only once', async () => {
	expect(toolRegistry.allTools()).toHaveLength(0)

	builtins.init()
	const firstCount = toolRegistry.allTools().length
	if (firstCount <= 0) throw new Error('expected builtins.init() to register tools')
	if (!toolRegistry.getTool('read')) throw new Error('expected read tool to be registered')
	if (!toolRegistry.getTool('bash')) throw new Error('expected bash tool to be registered')
	const wait = toolRegistry.getTool('wait')
	if (!wait) throw new Error('expected wait tool to be registered')
	expect(wait.description).toBe('Wait for the next subagent to finish. Ends the current turn; the subagent’s inbox message will start a new turn when it arrives.')
	expect(await wait.execute({}, { sessionId: 'test', cwd: '/tmp' })).toBe('No active subagents. Waiting for a message; send a prompt or spawn a subagent to resume.')

	builtins.init()
	expect(toolRegistry.allTools()).toHaveLength(firstCount)
})
