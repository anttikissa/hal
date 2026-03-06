import { describe, test, expect } from 'bun:test'
import { parseKey } from './cli-keys.ts'

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

	test('alt+letter', () => {
		const k = parseKey('\x1bb')!
		expect(k.key).toBe('b')
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

	test('kitty: key-up ignored', () => {
		expect(parseKey('\x1b[97;1:3u')).toBeNull()
	})

	test('multi-byte paste', () => {
		const k = parseKey('hello')!
		expect(k.char).toBe('hello')
	})
})
