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

	test('remaps replace refs after earlier inserts shift line numbers', () => {
		editTracker.resetForRead(sessionId, path)
		let lines = ['one', 'two', 'three', 'four']

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

		const oldRef = `2:${hashline.hashLine('two')}`
		const replaceTwo = requirePrepared(
			editRemap.prepareEdit({
				lines,
				sessionId,
				path,
				operation: 'replace',
				startRef: oldRef,
				endRef: oldRef,
				newContent: 'TWO',
			}),
		)

		expect(editRemap.buildResult(replaceTwo)).toContain('Line numbers changed; edit accepted as 3:')
		expect(replaceTwo.resultLines).toEqual(['top', 'one', 'TWO', 'three', 'four'])
	})

	test('remaps insert refs after earlier inserts shift line numbers', () => {
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

		const oldAfterRef = `2:${hashline.hashLine('two')}`
		const insertMid = requirePrepared(
			editRemap.prepareEdit({
				lines,
				sessionId,
				path,
				operation: 'insert',
				afterRef: oldAfterRef,
				newContent: 'mid',
			}),
		)

		expect(editRemap.buildResult(insertMid)).toContain('Line numbers changed; edit accepted after 3:')
		expect(insertMid.resultLines).toEqual(['top', 'one', 'two', 'mid', 'three'])
	})

	test('tracks replace deletion and insert blank-line semantics exactly', () => {
		expect(editRemap.normalizeReplaceLines('')).toEqual([])
		expect(editRemap.normalizeReplaceLines('foo\n')).toEqual(['foo'])
		expect(editRemap.normalizeInsertLines('')).toEqual([''])
		expect(editRemap.normalizeInsertLines('foo\n')).toEqual(['foo'])
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

		const staleBaseRef = `2:${hashline.hashLine('two')}`
		const staleResult = editRemap.prepareEdit({
			lines,
			sessionId,
			path,
			operation: 'replace',
			startRef: staleBaseRef,
			endRef: staleBaseRef,
			newContent: 'TWO',
		})
		expect(staleResult).toContain('Hash mismatch')
	})
})
