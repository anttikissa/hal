import { describe, test, expect } from 'bun:test'
import {
	getWrappedInputLayout,
	cursorToWrappedRowCol,
	wrappedRowColToCursor,
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
})
