import { expect, test } from 'bun:test'
import { helpers } from './helpers.ts'

test('truncateUtf8 leaves short text unchanged', () => {
	expect(helpers.truncateUtf8('hello', 10, '\n[… truncated]')).toBe('hello')
})

test('truncateUtf8 keeps suffix inside the byte limit', () => {
	const suffix = '\n[… truncated]'
	const out = helpers.truncateUtf8('🙂🙂🙂🙂🙂', 18, suffix)
	expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(18)
	expect(out.endsWith(suffix)).toBe(true)
})

test('truncateUtf8 falls back to a sliced suffix when the limit is tiny', () => {
	expect(helpers.truncateUtf8('hello', 3, 'abcdef')).toBe('abc')
})
