import { describe, test, expect } from 'bun:test'
import { keys } from '../src/client/terminal/keys.ts'

describe('keys', () => {
	test('parses bracketed paste as one token', () => {
		const parsed = keys.parseKeys('\x1b[200~hello\nworld\x1b[201~')
		expect(parsed).toEqual([{ key: 'hello\nworld', char: 'hello\nworld', shift: false, alt: false, ctrl: false, cmd: false }])
	})

	test('finds legacy and kitty emergency controls before stateful parsing', () => {
		for (const [input, index, key] of [['ab\x03', 2, 'c'], ['\x1b[114;5u', 0, 'r'], ['\x1a', 0, 'z']] as const) {
			expect(keys.emergencyKey(input)).toMatchObject({ index, key: { key, ctrl: true } })
		}
	})

	test('abandons an incomplete paste after it goes idle', () => {
		const pasteState = keys.state
		try {
			expect(keys.parseKeys('\x1b[200~interrupted')).toEqual([])
			pasteState.pasteUpdatedAt = 0
			expect(keys.parseKeys('x')).toEqual([{ key: 'x', char: 'x', shift: false, alt: false, ctrl: false, cmd: false }])
		} finally {
			keys.parseKeys('\x1b[201~')
		}
	})
})

test('complete OSC 11 replies set the background without becoming keystrokes', () => {
	const original = keys.state.background
	try {
		keys.state.background = null as number[] | null
		expect(keys.parseKeys('a\x1b]11;rgb:1234/5678/9abc\x1b\\b').map((key) => key.char).join('')).toBe('ab')
		expect(keys.state.background).toEqual([18, 86, 154])
		expect(keys.parseKeys('\x1b]11;rgb:ff/ff/ff\x07')).toEqual([])
		expect(keys.state.background).toEqual([255, 255, 255])
		keys.parseKeys('\x1b[200~\x1b]11;rgb:00/00/00\x07\x1b[201~')
		expect(keys.state.background).toEqual([255, 255, 255])
	} finally {
		keys.state.background = original
	}
})
