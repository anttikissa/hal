import { expect, test } from 'bun:test'
import { placeholders } from './placeholders.ts'

test('hal checkout gets hacking suggestions, other directories get general ones', () => {
	const general = placeholders.pick('/home/me/project', '/home/me/.hal', 0)
	expect(placeholders.general).toContain(general)
	const hal = placeholders.pick('/home/me/.hal', '/home/me/.hal', 0)
	expect(placeholders.hal).toContain(hal)
})

test('placeholder rotates with the turn count and wraps', () => {
	const first = placeholders.pick('/p', '/h', 0)
	expect(placeholders.pick('/p', '/h', 1)).not.toBe(first)
	expect(placeholders.pick('/p', '/h', placeholders.general.length)).toBe(first)
})
