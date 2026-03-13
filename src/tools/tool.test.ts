import { test, expect } from 'bun:test'
import { defineTool } from './tool.ts'

test('defineTool inherits default argsPreview from base tool', () => {
	const tool = defineTool({
		definition: {
			name: 'x',
			description: 'x',
			input_schema: { type: 'object', properties: {} },
		},
		execute: () => 'ok',
	})

	expect(tool.argsPreview({ anything: 'goes' })).toBe('')
	expect(Object.hasOwn(tool, 'argsPreview')).toBe(false)
})

test('defineTool can override argsPreview', () => {
	const tool = defineTool({
		definition: {
			name: 'y',
			description: 'y',
			input_schema: { type: 'object', properties: {} },
		},
		argsPreview: (input) => String((input as any)?.path ?? ''),
		execute: () => 'ok',
	})

	expect(tool.argsPreview({ path: 'foo.ts' })).toBe('foo.ts')
})
