import { expect, test } from 'bun:test'
import { time } from './time.ts'

test('formatResetAt uses clock for same-day resets', () => {
	const now = new Date(2026, 4, 20, 12, 0)
	const resetAt = new Date(2026, 4, 20, 15, 4).getTime()
	expect(time.formatResetAt(resetAt, now)).toBe('15:04')
})

test('formatResetAt includes date for later-day resets', () => {
	const now = new Date(2026, 4, 20, 12, 0)
	const resetAt = new Date(2026, 4, 21, 15, 4).getTime()
	expect(time.formatResetAt(resetAt, now)).toBe('15:04 on 21 May')
})

test('formatFutureDistance describes reset distance in human terms', () => {
	const now = new Date(2026, 4, 20, 12, 0).getTime()
	expect(time.formatFutureDistance(now + 30_000, now)).toBe('real soon now')
	expect(time.formatFutureDistance(now + 60_000, now)).toBe('in 1 minute')
	expect(time.formatFutureDistance(now + 35 * 60_000, now)).toBe('in 35 minutes')
	expect(time.formatFutureDistance(now + 60 * 60_000, now)).toBe('in 1 hour')
	expect(time.formatFutureDistance(now + 210 * 60_000, now)).toBe('in 3.5 hours')
})

test('formatQuotaWindow keeps compact subscription window labels', () => {
	expect(time.formatQuotaWindow(300)).toBe('5h')
	expect(time.formatQuotaWindow(10_080)).toBe('7d')
	expect(time.formatQuotaWindow(45)).toBe('45m')
})

test('formatSystemDate includes ISO date and weekday', () => {
	expect(time.formatSystemDate(new Date(2026, 4, 20, 12, 0))).toBe('2026-05-20, Wednesday')
})

test('formatLocalDateTime handles missing and invalid input', () => {
	expect(time.formatLocalDateTime(undefined)).toBeNull()
	expect(time.formatLocalDateTime('')).toBeNull()
	expect(time.formatLocalDateTime('not-a-date')).toBeNull()
	expect(time.formatLocalDateTime('2026-03-28T20:03:39.833Z')).toMatch(/^\d{1,2} [A-Z][a-z]{2} \d{2}:\d{2}$/)
})
