import { expect, test } from 'bun:test'
import { cursor } from './cursor.ts'

test('cursor visibility flips on 250ms boundaries', () => {
	const originalNow = Date.now
	try {
		Date.now = () => 0
		expect(cursor.isVisible()).toBe(true)

		Date.now = () => 249
		expect(cursor.isVisible()).toBe(true)

		Date.now = () => 250
		expect(cursor.isVisible()).toBe(false)

		Date.now = () => 499
		expect(cursor.isVisible()).toBe(false)

		Date.now = () => 500
		expect(cursor.isVisible()).toBe(true)
	} finally {
		Date.now = originalNow
	}
})
