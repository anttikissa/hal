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
	expect(await wait.execute({}, { sessionId: 'test', cwd: '/tmp' })).toBe('No subagents running. Either you didn\'t spawn them or they finished. Act accordingly.')

	builtins.init()
	expect(toolRegistry.allTools()).toHaveLength(firstCount)
})
