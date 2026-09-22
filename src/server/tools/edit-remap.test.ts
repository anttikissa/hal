import { beforeEach, describe, expect, test } from 'bun:test'
import { editRemap, type PreparedEdit } from './edit-remap.ts'
import { editTracker } from './edit-tracker.ts'
import { hashline } from './hashline.ts'

function requirePrepared(result: string | PreparedEdit): PreparedEdit {
	expect(typeof result).not.toBe('string')
	if (typeof result === 'string') throw new Error(result)
	return result
}

describe('editRemap', () => {
	const sessionId = 'test-session'
	const path = '/tmp/example.ts'

	beforeEach(() => {
		editTracker.clear(sessionId, path)
	})

	test('relocates a unique stale hash when restart lost the tracker', () => {
		const oldRef = `2:${hashline.hashLine('two')}`
		const edit = requirePrepared(editRemap.prepareEdit({
			lines: ['top', 'one', 'two'],
			sessionId,
			path,
			operation: 'replace',
			startRef: oldRef,
			endRef: oldRef,
			newContent: 'TWO',
		}))

		expect(edit.resultLines).toEqual(['top', 'one', 'TWO'])
	})

	test('editing inserted-only lines clears old remapping state', () => {
		editTracker.resetForRead(sessionId, path)
		let lines = ['one', 'two', 'three']

		const insertTop = requirePrepared(
			editRemap.prepareEdit({
				lines,
				sessionId,
				path,
				operation: 'insert',
				afterRef: '0:000',
				newContent: 'top',
			}),
		)
		lines = insertTop.resultLines
		editRemap.applyTrackerUpdate(sessionId, path, insertTop.trackerUpdate)
		expect(editTracker.has(sessionId, path)).toBe(true)

		const topRef = `1:${hashline.hashLine('top')}`
		const replaceTop = requirePrepared(
			editRemap.prepareEdit({
				lines,
				sessionId,
				path,
				operation: 'replace',
				startRef: topRef,
				endRef: topRef,
				newContent: 'TOP',
			}),
		)
		expect(replaceTop.trackerUpdate).toEqual({ kind: 'clear' })

		lines = replaceTop.resultLines
		editRemap.applyTrackerUpdate(sessionId, path, replaceTop.trackerUpdate)
		expect(editTracker.has(sessionId, path)).toBe(false)
	})
})
