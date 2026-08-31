import { expect, test } from 'bun:test'
import { cursor } from './cursor.ts'

test('shared heartbeat derives ten-frame tool and fifteen-frame cursor phases', () => {
	const originalNow = Date.now
	try {
		Date.now = () => 0
		expect(cursor.tick()).toBe(0)
		expect(cursor.toolTick()).toBe(0)
		Date.now = () => 167
		expect(cursor.tick()).toBe(0)
		expect(cursor.toolTick()).toBe(1)
		Date.now = () => 250
		expect(cursor.tick()).toBe(1)
		expect(cursor.toolTick()).toBe(1)
		Date.now = () => 500
		expect(cursor.tick()).toBe(2)
		expect(cursor.toolTick()).toBe(3)
	} finally {
		Date.now = originalNow
	}
})
