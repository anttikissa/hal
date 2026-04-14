import { expect, test } from 'bun:test'
import { builtins } from './builtins.ts'
import { toolRegistry } from './tool.ts'

test('builtins.init is idempotent', () => {
	const before = toolRegistry.allTools().length
	if (before <= 0) throw new Error('expected built-in tools to be registered on import')

	builtins.init()
	const firstCount = toolRegistry.allTools().length
	builtins.init()

	expect(firstCount).toBe(before)
	expect(toolRegistry.allTools()).toHaveLength(firstCount)
})
