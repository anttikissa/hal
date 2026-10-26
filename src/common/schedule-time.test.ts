// Clock schedules must keep both repeated instants and skip missing local times.
import { expect, test } from 'bun:test'
import { scheduleTime } from './schedule-time.ts'

test('normalizes durations, hourly, weekday, lists and inclusive ellipsis ranges', () => {
	for (let value of [
		'30m',
		'every hour',
		'hourly at :20',
		'every :30',
		'every hour at :30',
		'monday at 12:00',
		'Mon–Fri at 09:00',
		'daily at 09:00, 17:00',
		'09:00...19:00 every 1h',
	]) {
		let timing = scheduleTime.parse(value)
		expect(scheduleTime.parse(scheduleTime.format(timing))).toEqual(timing)
	}
	expect(scheduleTime.parse('09:00…19:00')).toEqual({ minutes: Array.from({ length: 11 }, (_, i) => (9 + i) * 60) })
	for (let bad of ['0m', '-1h', '25:00', '12:60', '19:00..09:00', 'every :60', 'nonsense'])
		expect(() => scheduleTime.parse(bad)).toThrow()
})

test('Helsinki DST repeats both 03:30 instants and skips nonexistent 03:30', () => {
	let weekly = scheduleTime.parse('sunday at 03:30')
	expect(new Date(scheduleTime.next(weekly, Date.parse('2026-03-22T01:30:00Z'), 'Europe/Helsinki')).toISOString()).toBe(
		'2026-04-05T00:30:00.000Z',
	)
	let timing = scheduleTime.parse('03:30')
	let next = (after: string) => new Date(scheduleTime.next(timing, Date.parse(after), 'Europe/Helsinki')).toISOString()
	expect(next('2026-10-24T23:00:00Z')).toBe('2026-10-25T00:30:00.000Z')
	expect(next('2026-10-25T00:30:00Z')).toBe('2026-10-25T01:30:00.000Z')
	expect(next('2026-03-28T23:00:00Z')).toBe('2026-03-30T00:30:00.000Z')
	expect(
		new Date(
			scheduleTime.next(scheduleTime.parse('monday at 12:00'), Date.parse('2026-10-25T14:00:00Z'), 'Europe/Helsinki'),
		).toISOString(),
	).toBe('2026-10-26T10:00:00.000Z')
})
