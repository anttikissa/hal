import { beforeEach, describe, expect, test } from 'bun:test'
import { editTracker } from './edit-tracker.ts'

describe('editTracker', () => {
	const sessionId = 'test-session'
	const path = '/tmp/example.ts'

	beforeEach(() => {
		editTracker.clear(sessionId, path)
	})

	test('insert shifts later base lines forward', () => {
		editTracker.resetForRead(sessionId, path)
		editTracker.applyInsert(sessionId, path, 5, 3)

		expect(editTracker.mapBaseLineToCurrent(sessionId, path, 5)).toBe(5)
		expect(editTracker.mapBaseLineToCurrent(sessionId, path, 6)).toBe(9)
		expect(editTracker.mapCurrentLineToBase(sessionId, path, 9)).toBe(6)
		expect(editTracker.mapCurrentLineToBase(sessionId, path, 7)).toBeNull()
	})

	test('replace marks edited base lines stale and shifts the tail', () => {
		editTracker.resetForRead(sessionId, path)
		editTracker.applyReplace(sessionId, path, 10, 14, 3)

		expect(editTracker.mapBaseLineToCurrent(sessionId, path, 9)).toBe(9)
		expect(editTracker.mapBaseLineToCurrent(sessionId, path, 10)).toBeNull()
		expect(editTracker.mapBaseLineToCurrent(sessionId, path, 15)).toBe(13)
		expect(editTracker.mapCurrentLineToBase(sessionId, path, 12)).toBeNull()
		expect(editTracker.mapCurrentLineToBase(sessionId, path, 13)).toBe(15)
	})

	test('sequential edits split offsets across the file', () => {
		editTracker.resetForRead(sessionId, path)
		editTracker.applyReplace(sessionId, path, 10, 14, 3)
		editTracker.applyReplace(sessionId, path, 20, 22, 0)

		expect(editTracker.mapBaseLineToCurrent(sessionId, path, 17)).toBe(15)
		expect(editTracker.mapBaseLineToCurrent(sessionId, path, 23)).toBe(18)
		expect(editTracker.mapCurrentLineToBase(sessionId, path, 15)).toBe(17)
		expect(editTracker.mapCurrentLineToBase(sessionId, path, 16)).toBe(18)
		expect(editTracker.mapCurrentLineToBase(sessionId, path, 17)).toBe(19)
		expect(editTracker.mapCurrentLineToBase(sessionId, path, 18)).toBe(23)
	})

	test('read reset clears old offsets', () => {
		editTracker.resetForRead(sessionId, path)
		editTracker.applyInsert(sessionId, path, 1, 2)
		expect(editTracker.mapBaseLineToCurrent(sessionId, path, 2)).toBe(4)

		editTracker.resetForRead(sessionId, path)
		expect(editTracker.mapBaseLineToCurrent(sessionId, path, 2)).toBe(2)
		expect(editTracker.mapCurrentLineToBase(sessionId, path, 4)).toBe(4)
	})
})
