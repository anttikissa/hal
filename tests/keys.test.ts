import { describe, test, expect } from 'bun:test'
import { keys } from '../src/cli/keys.ts'

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
})
