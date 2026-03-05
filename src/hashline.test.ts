import { describe, test, expect } from 'bun:test'
import { hashLine, formatWithHashlines, parseRef, applyEdit, applyInsert } from './hashline'

describe('hashline', () => {
	test('parseRef parses valid refs', () => {
		expect(parseRef('1:abc')).toEqual({ line: 1, hash: 'abc' })
		expect(parseRef('42:aZ9')).toEqual({ line: 42, hash: 'aZ9' })
	})

	test('parseRef rejects invalid refs', () => {
		expect(parseRef('1:ab')).toBeNull()
		expect(parseRef('x:abc')).toBeNull()
		expect(parseRef('1:abcd')).toBeNull()
		expect(parseRef('1-abc')).toBeNull()
	})

	test('formatWithHashlines prefixes each line with line number and hash', () => {
		const out = formatWithHashlines('a\nb')
		const lines = out.split('\n')
		expect(lines).toHaveLength(2)
		expect(lines[0]).toBe(`1:${hashLine('a')} a`)
		expect(lines[1]).toBe(`2:${hashLine('b')} b`)
	})

	test('applyEdit replaces a single line and returns context', () => {
		const content = 'alpha\nbeta\ngamma'
		const ref = `2:${hashLine('beta')}`
		const res = applyEdit(content, ref, ref, 'BETA')
		expect(res.error).toBeUndefined()
		expect(res.result).toBe('alpha\nBETA\ngamma')
		expect(res.context).toContain('--- before')
		expect(res.context).toContain('+++ after')
		expect(res.context).toContain('beta')
		expect(res.context).toContain('BETA')
	})

	test('applyEdit replaces a range and can delete with empty content', () => {
		const content = 'a\nb\nc\nd'
		const start = `2:${hashLine('b')}`
		const end = `3:${hashLine('c')}`
		expect(applyEdit(content, start, end, 'X\nY').result).toBe('a\nX\nY\nd')
		expect(applyEdit(content, start, end, '').result).toBe('a\nd')
	})

	test('applyEdit returns clear errors for invalid order and hash mismatch', () => {
		const content = 'a\nb\nc'
		const line2 = `2:${hashLine('b')}`
		const line1 = `1:${hashLine('a')}`
		const bad = '2:zzz'

		expect(applyEdit(content, line2, line1, 'x').error).toContain('after end line')
		expect(applyEdit(content, bad, bad, 'x').error).toContain('Hash mismatch')
	})

	test('applyInsert inserts at beginning with 0:000 and after a line', () => {
		const content = 'a\nb'
		expect(applyInsert(content, '0:000', 'top').result).toBe('top\na\nb')

		const after1 = `1:${hashLine('a')}`
		expect(applyInsert(content, after1, 'mid').result).toBe('a\nmid\nb')
	})

	test('edits preserve spaces, empty lines, and unicode', () => {
		const content = '  keep  \n\nö'
		const ref3 = `3:${hashLine('ö')}`
		const res = applyEdit(content, ref3, ref3, '🙂')
		expect(res.result).toBe('  keep  \n\n🙂')
	})
})
