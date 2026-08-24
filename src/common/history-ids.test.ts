import { expect, test } from 'bun:test'
import { historyIds } from './history-ids.ts'

test('history IDs keep the timestamp-random format', () => {
	expect(historyIds.make()).toMatch(/^[a-z0-9]{6}-[a-z0-9]{3}$/)
	expect(historyIds.isValid('000001-abc')).toBe(true)
	expect(historyIds.isValid('bad')).toBe(false)
})
