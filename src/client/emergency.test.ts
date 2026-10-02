import { describe, test, expect } from 'bun:test'
import { emergency } from '../common/emergency.ts'

// Feed chunks through one scanner; returns every action found.
function scan(...chunks: (string | Uint8Array)[]): string[] {
	let s = emergency.createState()
	return chunks.flatMap((c) => emergency.scan(s, c))
}

const bytes = (s: string) => new TextEncoder().encode(s)

describe('legacy control bytes', () => {
	test('Ctrl-C, Ctrl-Z and Ctrl-R', () => {
		expect(scan('\x03')).toEqual(['quit'])
		expect(scan('\x1a')).toEqual(['suspend'])
		expect(scan('\x12')).toEqual(['restart'])
		expect(scan(bytes('\x12'))).toEqual(['restart'])
	})

	test('other bytes are not emergencies', () => {
		expect(scan('abc\r\x04\x7f\x1b[A\x1b')).toEqual([])
	})

	test('found among text, in order', () => {
		expect(scan('ab\x1acd\x03')).toEqual(['suspend', 'quit'])
	})

	test('inside UTF-8 bytes split across chunks', () => {
		let e = bytes('é')
		expect(scan(e.slice(0, 1), bytes('\x03'), e.slice(1))).toEqual(['quit'])
	})

	test('buried in an unfinished escape sequence', () => {
		expect(scan('\x1b[1;', '\x03')).toEqual(['quit'])
		expect(scan('\x1b[1;5\x12')).toEqual(['restart'])
		expect(scan('\x1b]11;rgb:\x1a')).toEqual(['suspend'])
	})

	test('inside an unfinished bracketed paste', () => {
		expect(scan('\x1b[200~some long paste', 'still going\x03')).toEqual(['quit'])
	})

	test('Alt-prefixed', () => {
		expect(scan('\x1b\x03')).toEqual(['quit'])
	})
})

describe('kitty CSI-u forms', () => {
	test('Ctrl-c, Ctrl-z, Ctrl-r', () => {
		expect(scan('\x1b[99;5u')).toEqual(['quit'])
		expect(scan('\x1b[122;5u')).toEqual(['suspend'])
		expect(scan('\x1b[114;5u')).toEqual(['restart'])
	})

	test('with lock modifiers, alternates, press and repeat events', () => {
		expect(scan('\x1b[99;69u')).toEqual(['quit']) // caps lock
		expect(scan('\x1b[99;133u')).toEqual(['quit']) // num lock
		expect(scan('\x1b[99:67;6u')).toEqual(['quit']) // shift + alternate
		expect(scan('\x1b[99;5:1u', '\x1b[99;5:2u')).toEqual(['quit', 'quit'])
	})

	test('releases and other modifiers are not emergencies', () => {
		expect(scan('\x1b[99;5:3u')).toEqual([]) // release
		expect(scan('\x1b[99u')).toEqual([]) // plain c
		expect(scan('\x1b[99;7u')).toEqual([]) // ctrl+alt
		expect(scan('\x1b[99;13u')).toEqual([]) // ctrl+super
		expect(scan('\x1b[100;5u')).toEqual([]) // ctrl+d
		expect(scan('\x1b[199;5u')).toEqual([]) // a longer code point
	})

	test('split across chunks at every byte', () => {
		let seq = 'x\x1b[114;5uy'
		for (let i = 1; i < seq.length; i++) {
			expect(scan(seq.slice(0, i), seq.slice(i))).toEqual(['restart'])
		}
		expect(scan(...'\x1b[122;5u')).toEqual(['suspend'])
	})

	test('after a sequence that was cut short', () => {
		expect(scan('\x1b[1;\x1b[99;5u')).toEqual(['quit'])
	})

	test('a split prefix that turns out otherwise is forgotten', () => {
		expect(scan('\x1b[99;', 'x', '5u')).toEqual([])
	})
})
