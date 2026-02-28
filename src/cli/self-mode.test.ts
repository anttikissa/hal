import { describe, test, expect } from 'bun:test'
import { parseContextPct } from './client.ts'

describe('parseContextPct', () => {
	test('null input returns null', () => {
		expect(parseContextPct(null)).toBe(null)
	})

	test('parses estimated percentage', () => {
		expect(parseContextPct('~5.2%/200k')).toBe(5.2)
	})

	test('parses exact percentage', () => {
		expect(parseContextPct('42.0%/200k')).toBe(42.0)
	})

	test('parses integer percentage', () => {
		expect(parseContextPct('~0%/200k')).toBe(0)
	})

	test('parses 100%', () => {
		expect(parseContextPct('100.0%/200k')).toBe(100.0)
	})

	test('returns null for garbage', () => {
		expect(parseContextPct('no-match')).toBe(null)
	})
})
