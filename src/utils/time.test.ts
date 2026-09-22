import { expect, test } from 'bun:test'
import { time } from './time.ts'

test('formatRetryDelay gives the exact wait and local retry time', () => {
	const now = new Date(2026, 4, 20, 13, 29).getTime()

	expect(time.formatRetryDelay(12_138_000, now)).toBe('202 min 18 sec (at 16:51)')
	expect(time.formatRetryDelay(65_000, now)).toBe('1 min 5 sec (at 13:30)')
})
