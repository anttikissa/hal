import { expect, test } from 'bun:test'
import { toolRegistry } from './tool.ts'
import './google.ts'

test('registers the google tool', () => {
	expect(toolRegistry.getTool('google')?.name).toBe('google')
	expect(toolRegistry.getTool('web_search')).toBeNull()
})
