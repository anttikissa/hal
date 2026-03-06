import { describe, test, expect } from 'bun:test'
import {
	wordWrapLines,
	getWrappedInputLayout,
	cursorToWrappedRowCol,
	wrappedRowColToCursor,
	verticalMove,
} from './input.ts'

describe('wordWrapLines', () => {
	test('no wrap needed', () => {
		expect(wordWrapLines('hello', 80)).toEqual(['hello'])
	})

	test('wraps at word boundary', () => {
		expect(wordWrapLines('hello world', 6)).toEqual(['hello', 'world'])
	})

	test('hard wrap when no space', () => {
		expect(wordWrapLines('abcdef', 3)).toEqual(['abc', 'def'])
	})

	test('newlines create separate segments', () => {
		expect(wordWrapLines('ab\ncd', 80)).toEqual(['ab', 'cd'])
	})

	test('empty string', () => {
		expect(wordWrapLines('', 80)).toEqual([''])
	})
})

describe('input layout', () => {
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
})

describe('verticalMove', () => {
	test('goal column is remembered across short lines', () => {
		const input = 'longlonglongloXnglong\nshort\nlonglonglongloYnglong'
		const width = 80

		const cursor0 = 14
		const r1 = verticalMove(input, width, cursor0, null, 1)
		expect(r1.goalCol).toBe(14)
		expect(r1.cursor).toBe(27)
		expect(r1.atBoundary).toBe(false)

		const r2 = verticalMove(input, width, r1.cursor, r1.goalCol, 1)
		expect(r2.cursor).toBe(42)
		expect(r2.goalCol).toBe(14)
		expect(r2.atBoundary).toBe(false)
	})

	test('atBoundary at top', () => {
		const r = verticalMove('abc\ndef', 80, 1, null, -1)
		expect(r.atBoundary).toBe(true)
		expect(r.cursor).toBe(1)
	})

	test('atBoundary at bottom', () => {
		const r = verticalMove('abc\ndef', 80, 5, null, 1)
		expect(r.atBoundary).toBe(true)
		expect(r.cursor).toBe(5)
	})
})
