import { expect, test } from 'bun:test'
import { historyProjection } from './history-projection.ts'

test('input history projects local persisted user input with display text', () => {
	const entries = [
		{ type: 'user' as const, parts: [{ type: 'text' as const, text: 'pasted text', displayText: '[...paste]' }] },
		{ type: 'user' as const, parts: [{ type: 'text' as const, text: 'handoff' }], source: '04-other' },
	]

	expect(historyProjection.inputHistoryFromEntries(entries)).toEqual(['[...paste]'])
})
