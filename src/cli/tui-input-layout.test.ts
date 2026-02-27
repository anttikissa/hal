import { describe, test, expect } from 'bun:test'
import {
	getWrappedInputLayout,
	cursorToWrappedRowCol,
	wrappedRowColToCursor,
	verticalMove,
} from './tui-input-layout.ts'

describe('tui input layout', () => {
	test('getWrappedInputLayout computes start offsets across spaces/newlines', () => {
		const input = 'ab cd\nef gh'
		const layout = getWrappedInputLayout(input, 3)

		expect(layout.lines).toEqual(['ab', 'cd', 'ef', 'gh'])
		expect(layout.starts).toEqual([0, 3, 6, 9])
	})

	test('cursorToWrappedRowCol maps absolute cursor to visual row/col', () => {
		const input = 'ab cd\nef gh'
		const width = 3

		expect(cursorToWrappedRowCol(input, 0, width)).toEqual({ row: 0, col: 0 })
		expect(cursorToWrappedRowCol(input, 3, width)).toEqual({ row: 1, col: 0 })
		expect(cursorToWrappedRowCol(input, 5, width)).toEqual({ row: 1, col: 2 })
		expect(cursorToWrappedRowCol(input, 6, width)).toEqual({ row: 2, col: 0 })
	})

	test('wrappedRowColToCursor is inverse mapping for valid row/col pairs', () => {
		const input = 'ab cd\nef gh'
		const width = 3
		const layout = getWrappedInputLayout(input, width)

		for (let row = 0; row < layout.lines.length; row++) {
			for (let col = 0; col <= layout.lines[row].length; col++) {
				const cursor = wrappedRowColToCursor(input, row, col, width)
				const roundTrip = cursorToWrappedRowCol(input, cursor, width)
				expect(roundTrip).toEqual({ row, col })
			}
		}
	})

	test('Shift+Up/Down regression: vertical movement in wrapped multiline input round-trips', () => {
		const input = 'ab cd\nef gh'
		const width = 3

		const startCursor = wrappedRowColToCursor(input, 2, 1, width)
		const upCursor = wrappedRowColToCursor(input, 1, 1, width)
		const downCursor = wrappedRowColToCursor(input, 2, 1, width)

		expect(startCursor).toBe(7)
		expect(upCursor).toBe(4)
		expect(downCursor).toBe(startCursor)
	})

	describe('verticalMove (goal column)', () => {
		// longlonglongloXnglong  (col 14)
		// short                  (col 5 = end, but goalCol stays 14)
		// longlonglongloYnglong  (col 14, restored)
		test('goal column is remembered across short lines', () => {
			const input = 'longlonglongloXnglong\nshort\nlonglonglongloYnglong'
			const width = 80
			// starts: [0, 22, 28]

			// Start at X (position 14, col 14)
			const cursor0 = 14
			const r1 = verticalMove(input, width, cursor0, null, 1)
			expect(r1.goalCol).toBe(14)
			expect(r1.cursor).toBe(27) // end of "short" = starts[1]+5
			expect(r1.atBoundary).toBe(false)

			// Press down again with remembered goalCol
			const r2 = verticalMove(input, width, r1.cursor, r1.goalCol, 1)
			expect(r2.cursor).toBe(42) // starts[2]+14 = Y position
			expect(r2.goalCol).toBe(14)
			expect(r2.atBoundary).toBe(false)
		})

		test('goal column is set from current col on first move', () => {
			const input = 'abcdef\ngh'
			const width = 80

			// Start at col 4 of first line, move down
			const r = verticalMove(input, width, 4, null, 1)
			expect(r.goalCol).toBe(4)
			// "gh" has length 2, so clamp to col 2
			expect(r.cursor).toBe(7 + 2) // starts[1]=7, col clamped to 2
		})

		test('atBoundary is true when at top and moving up', () => {
			const input = 'abc\ndef'
			const width = 80

			const r = verticalMove(input, width, 1, null, -1)
			expect(r.atBoundary).toBe(true)
			expect(r.cursor).toBe(1) // unchanged
		})

		test('atBoundary is true when at bottom and moving down', () => {
			const input = 'abc\ndef'
			const width = 80

			const r = verticalMove(input, width, 5, null, 1)
			expect(r.atBoundary).toBe(true)
			expect(r.cursor).toBe(5) // unchanged
		})

		test('works going up through a short line', () => {
			const input = 'longlonglongloYnglong\nshort\nlonglonglongloXnglong'
			const width = 80
			// starts: [0, 22, 28]

			// Start at X (col 14 of line 2 = cursor 42), press up twice
			const cursor0 = 42
			const r1 = verticalMove(input, width, cursor0, null, -1)
			expect(r1.goalCol).toBe(14)
			expect(r1.cursor).toBe(27) // end of "short"

			const r2 = verticalMove(input, width, r1.cursor, r1.goalCol, -1)
			expect(r2.cursor).toBe(14) // col 14 of first line
			expect(r2.goalCol).toBe(14)
		})
	})
})
