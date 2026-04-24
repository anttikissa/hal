import { afterEach, expect, test } from 'bun:test'
import { toolRegistry } from './tool.ts'

const originalMaxOutputBytes = toolRegistry.config.maxOutputBytes

afterEach(() => {
	toolRegistry.clearForTests()
	toolRegistry.config.maxOutputBytes = originalMaxOutputBytes
})

test('dispatch caps every tool result by UTF-8 bytes with recovery guidance', async () => {
	toolRegistry.config.maxOutputBytes = 1024
	toolRegistry.registerTool({
		name: 'huge',
		description: 'test huge output',
		parameters: {},
		execute: async () => 'å'.repeat(2000),
	})

	const out = await toolRegistry.dispatch('huge', {}, { sessionId: 's', cwd: process.cwd() })

	expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(1024)
	expect(out).toContain('tool result truncated')
	expect(out).toContain('toolRegistry.config.maxOutputBytes')
})
