import { describe, test, expect } from 'bun:test'
import { parseKey, parseKeys } from './keys.ts'

describe('parseKey', () => {
	test('printable characters', () => {
		const k = parseKey('a')!
		expect(k.key).toBe('a')
		expect(k.char).toBe('a')
		expect(k.shift).toBe(false)
	})

	test('uppercase has char', () => {
		const k = parseKey('A')!
		expect(k.key).toBe('a')
		expect(k.char).toBe('A')
	})

	test('enter', () => {
		expect(parseKey('\r')!.key).toBe('enter')
		expect(parseKey('\r')!.ctrl).toBe(false)
		expect(parseKey('\n')!.key).toBe('enter')
	})

	test('backspace', () => {
		expect(parseKey('\x7f')!.key).toBe('backspace')
		expect(parseKey('\x7f')!.ctrl).toBe(false)
	})

	test('tab', () => {
		expect(parseKey('\t')!.key).toBe('tab')
		expect(parseKey('\t')!.ctrl).toBe(false)
	})

	test('ctrl+c', () => {
		const k = parseKey('\x03')!
		expect(k.key).toBe('c')
		expect(k.ctrl).toBe(true)
	})

	test('ctrl+a', () => {
		const k = parseKey('\x01')!
		expect(k.key).toBe('a')
		expect(k.ctrl).toBe(true)
	})

	test('escape', () => {
		expect(parseKey('\x1b')!.key).toBe('escape')
	})

	test('arrow keys', () => {
		expect(parseKey('\x1b[A')!.key).toBe('up')
		expect(parseKey('\x1b[B')!.key).toBe('down')
		expect(parseKey('\x1b[C')!.key).toBe('right')
		expect(parseKey('\x1b[D')!.key).toBe('left')
	})

	test('shift+arrow', () => {
		const k = parseKey('\x1b[1;2D')!
		expect(k.key).toBe('left')
		expect(k.shift).toBe(true)
		expect(k.alt).toBe(false)
	})

	test('alt+arrow', () => {
		const k = parseKey('\x1b[1;3A')!
		expect(k.key).toBe('up')
		expect(k.alt).toBe(true)
		expect(k.shift).toBe(false)
	})

	test('shift+alt+arrow', () => {
		const k = parseKey('\x1b[1;4C')!
		expect(k.key).toBe('right')
		expect(k.shift).toBe(true)
		expect(k.alt).toBe(true)
	})

	test('alt+enter', () => {
		const k = parseKey('\x1b\r')!
		expect(k.key).toBe('enter')
		expect(k.alt).toBe(true)
	})

	test('alt+b/f normalize to alt+left/right', () => {
		expect(parseKey('\x1bb')!.key).toBe('left')
		expect(parseKey('\x1bb')!.alt).toBe(true)
		expect(parseKey('\x1bf')!.key).toBe('right')
		expect(parseKey('\x1bf')!.alt).toBe(true)
	})

	test('alt+letter', () => {
		const k = parseKey('\x1bg')!
		expect(k.key).toBe('g')
		expect(k.alt).toBe(true)
	})

	test('delete key', () => {
		expect(parseKey('\x1b[3~')!.key).toBe('delete')
	})

	test('home/end', () => {
		expect(parseKey('\x1b[H')!.key).toBe('home')
		expect(parseKey('\x1b[F')!.key).toBe('end')
	})

	test('alt+backspace', () => {
		const k = parseKey('\x1b\x7f')!
		expect(k.key).toBe('backspace')
		expect(k.alt).toBe(true)
		expect(k.ctrl).toBe(false)
	})

	// Kitty CSI u format
	test('kitty: plain a', () => {
		const k = parseKey('\x1b[97;1u')!
		expect(k.key).toBe('a')
		expect(k.char).toBe('a')
	})

	test('kitty: cmd+c', () => {
		const k = parseKey('\x1b[99;9u')!
		expect(k.key).toBe('c')
		expect(k.cmd).toBe(true)
		expect(k.char).toBeUndefined()
	})

	test('kitty: cmd+a', () => {
		const k = parseKey('\x1b[97;9u')!
		expect(k.key).toBe('a')
		expect(k.cmd).toBe(true)
	})

	test('kitty: shift+a', () => {
		const k = parseKey('\x1b[97;2;65u')!
		expect(k.key).toBe('a')
		expect(k.shift).toBe(true)
		expect(k.char).toBe('A')
	})

	test('kitty: enter', () => {
		const k = parseKey('\x1b[13;1u')!
		expect(k.key).toBe('enter')
	})

	test('kitty: shift+enter', () => {
		const k = parseKey('\x1b[13;2u')!
		expect(k.key).toBe('enter')
		expect(k.shift).toBe(true)
	})

	test('kitty: key-up ignored', () => {
		expect(parseKey('\x1b[97;1:3u')).toBeNull()
	})

	test('kitty: CSI functional key-up ignored', () => {
		// shift+option+left release: \x1b[1;4:3D
		expect(parseKey('\x1b[1;4:3D')).toBeNull()
	})

	test('kitty: CSI functional key press works', () => {
		const k = parseKey('\x1b[1;4:1D')!
		expect(k.key).toBe('left')
		expect(k.shift).toBe(true)
		expect(k.alt).toBe(true)
	})

	test('kitty: tilde key-up ignored', () => {
		// delete release: \x1b[3;1:3~
		expect(parseKey('\x1b[3;1:3~')).toBeNull()
	})

	test('multi-byte paste', () => {
		const k = parseKey('hello')!
		expect(k.char).toBe('hello')
	})
})


describe('parseKeys (concatenated sequences)', () => {
	test('splits concatenated CSI sequences', () => {
		// Two arrow keys in one chunk
		const events = parseKeys('\x1b[A\x1b[B')
		expect(events.length).toBe(2)
		expect(events[0].key).toBe('up')
		expect(events[1].key).toBe('down')
	})

	test('Ghostty shift+enter: press + release tokens', () => {
		// Ghostty sends: shift-press, enter-press, enter-release, shift-release
		const raw = '\x1b[57441;2u\x1b[13;2u\x1b[13;2:3u\x1b[57441;1:3u'
		const events = parseKeys(raw)
		// shift key (private-use) and releases are filtered out
		// only the enter press should survive
		expect(events.length).toBe(1)
		expect(events[0].key).toBe('enter')
		expect(events[0].shift).toBe(true)
	})

	test('single key passes through', () => {
		const events = parseKeys('a')
		expect(events.length).toBe(1)
		expect(events[0].key).toBe('a')
	})

	test('plain enter not affected', () => {
		const events = parseKeys('\r')
		expect(events.length).toBe(1)
		expect(events[0].key).toBe('enter')
		expect(events[0].shift).toBe(false)
	})

	test('bracketed paste extracts content as single char event', () => {
		const events = parseKeys('\x1b[200~hello world\x1b[201~')
		expect(events.length).toBe(1)
		expect(events[0].char).toBe('hello world')
	})

	test('bracketed paste with surrounding keys', () => {
		const events = parseKeys('a\x1b[200~pasted\x1b[201~b')
		expect(events.length).toBe(3)
		expect(events[0].char).toBe('a')
		expect(events[1].char).toBe('pasted')
		expect(events[2].char).toBe('b')
	})

	test('bracketed paste with multiline content', () => {
		const events = parseKeys('\x1b[200~line1\nline2\nline3\x1b[201~')
		expect(events.length).toBe(1)
		expect(events[0].char).toBe('line1\nline2\nline3')
	})

	test('empty bracketed paste produces no events', () => {
		const events = parseKeys('\x1b[200~\x1b[201~')
		expect(events.length).toBe(0)
	})
})