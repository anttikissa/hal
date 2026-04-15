import { expect, test } from 'bun:test'
import { builtins } from './builtins.ts'
import { toolRegistry } from './tool.ts'

toolRegistry.clearForTests()
builtins.state.initialized = false
test('builtins.init registers tools lazily and only once', () => {
	expect(toolRegistry.allTools()).toHaveLength(0)

	builtins.init()
	const firstCount = toolRegistry.allTools().length
	if (firstCount <= 0) throw new Error('expected builtins.init() to register tools')
	if (!toolRegistry.getTool('read')) throw new Error('expected read tool to be registered')
	if (!toolRegistry.getTool('bash')) throw new Error('expected bash tool to be registered')

	builtins.init()
	expect(toolRegistry.allTools()).toHaveLength(firstCount)
})
