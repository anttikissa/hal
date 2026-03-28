import { expect, test } from 'bun:test'
import { apiMessages } from './api-messages.ts'

test('formatLocalTime returns HH:MM in local time', () => {
	const result = apiMessages.formatLocalTime('2026-03-28T20:03:39.833Z')
	// Should be a HH:MM string (exact value depends on system timezone)
	expect(result).toMatch(/^\d{2}:\d{2}$/)
})

test('formatLocalTime returns null for missing/invalid input', () => {
	expect(apiMessages.formatLocalTime(undefined)).toBeNull()
	expect(apiMessages.formatLocalTime('')).toBeNull()
	expect(apiMessages.formatLocalTime('not-a-date')).toBeNull()
})
