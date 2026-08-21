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
	if (typeof out !== 'string') throw new Error('expected text output')

	expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(1024)
	expect(out).toContain('tool result truncated')
	expect(out).toContain('toolRegistry.config.maxOutputBytes')
})

test('dispatch rejects rich tool results over 1MB', async () => {
	toolRegistry.registerTool({
		name: 'huge-image',
		description: 'test huge image',
		parameters: {},
		execute: async () => [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x'.repeat(1_000_000) } }],
	})

	expect(await toolRegistry.dispatch('huge-image', {}, { sessionId: 's', cwd: process.cwd() })).toBe(
		'error: tool result exceeds the 1MB limit',
	)
})
