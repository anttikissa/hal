import { test, expect } from 'bun:test'
import { maxTabHeight } from './heights.ts'

test('maxTabHeight hydrates non-active tab heights from blocks', () => {
	const tabs = [
		{ sessionId: 'a', blocks: [{ type: 'assistant', text: 'short', done: true }], contentHeight: 1 },
		{ sessionId: 'b', blocks: [{ type: 'assistant', text: 'line 1\nline 2\nline 3', done: true }], contentHeight: 0 },
	]

	const max = maxTabHeight(tabs as any, 'a', 80, 1)

	expect(max).toBeGreaterThanOrEqual(3)
	expect(tabs[1].contentHeight).toBeGreaterThanOrEqual(3)
})

test('maxTabHeight preserves larger remembered height for active tab', () => {
	const tabs = [
		{ sessionId: 'a', blocks: [], contentHeight: 20 },
		{ sessionId: 'b', blocks: [], contentHeight: 5 },
	]

	const max = maxTabHeight(tabs as any, 'a', 80, 2)

	expect(max).toBe(20)
	expect(tabs[0].contentHeight).toBe(20)
})
