import { describe, test, expect } from 'bun:test'
import { keys } from '../src/client/terminal/keys.ts'

describe('keys', () => {
	test('parses alt-left and alt-right word navigation', () => {
		expect(keys.parseKey('\x1bb')).toEqual({ key: 'left', shift: false, alt: true, ctrl: false, cmd: false })
		expect(keys.parseKey('\x1bf')).toEqual({ key: 'right', shift: false, alt: true, ctrl: false, cmd: false })
	})

	test('parses kitty cmd shortcuts', () => {
		expect(keys.parseKey('\x1b[120;9u')).toEqual({ key: 'x', shift: false, alt: false, ctrl: false, cmd: true })
		expect(keys.parseKey('\x1b[118;9u')).toEqual({ key: 'v', shift: false, alt: false, ctrl: false, cmd: true })
	})

	test('parses cmd-left and cmd-right from CSI modifiers', () => {
		expect(keys.parseKey('\x1b[1;9D')).toEqual({ key: 'left', shift: false, alt: false, ctrl: false, cmd: true })
		expect(keys.parseKey('\x1b[1;9C')).toEqual({ key: 'right', shift: false, alt: false, ctrl: false, cmd: true })
	})

	test('parses ctrl-shift-tab from kitty CSI-u', () => {
		expect(keys.parseKey('\x1b[9;6u')).toEqual({ key: 'tab', shift: true, alt: false, ctrl: true, cmd: false })
	})

	test('parses legacy shift-tab', () => {
		expect(keys.parseKey('\x1b[Z')).toEqual({ key: 'tab', shift: true, alt: false, ctrl: false, cmd: false })
	})

	test('parses bracketed paste as one token', () => {
		const parsed = keys.parseKeys('\x1b[200~hello\nworld\x1b[201~')
		expect(parsed).toEqual([{ key: 'hello\nworld', char: 'hello\nworld', shift: false, alt: false, ctrl: false, cmd: false }])
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
