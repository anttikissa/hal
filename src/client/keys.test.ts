import { describe, test, expect } from 'bun:test'
import { keys, type KeyEvent } from './keys.ts'

// Feed chunks through one decoder; returns compact "name" strings:
// modifiers as prefixes (C-, M-, S-), text events as their text.
function decode(...chunks: (string | Uint8Array)[]): string[] {
	let s = keys.createState()
	let out: KeyEvent[] = []
	for (let c of chunks) out.push(...keys.feed(s, c))
	return out.map(show)
}

function show(k: KeyEvent): string {
	if (k.key === 'paste') return `paste:${JSON.stringify(k.text)}`
	if (k.text !== undefined && !k.ctrl && !k.alt) return `text:${k.text}`
	return (k.cmd ? 's-' : '') + (k.ctrl ? 'C-' : '') + (k.alt ? 'M-' : '') + (k.shift ? 'S-' : '') + k.key
}

const bytes = (s: string) => new TextEncoder().encode(s)

describe('single chunks', () => {
	test('printable text becomes one event per code point', () => {
		expect(decode('aB 😀é')).toEqual(['text:a', 'text:B', 'text: ', 'text:😀', 'text:é'])
	})

	test('control keys', () => {
		expect(decode('\r', '\x7f', '\b', '\x04', '\t')).toEqual(['enter', 'backspace', 'backspace', 'C-d', 'tab'])
	})

	test('arrows in normal and application cursor mode', () => {
		expect(decode('\x1b[A\x1b[B\x1b[C\x1b[D')).toEqual(['up', 'down', 'right', 'left'])
		expect(decode('\x1bOA\x1bOD')).toEqual(['up', 'left'])
		expect(decode('\x1b[1;2D\x1b[1;5C')).toEqual(['S-left', 'C-right'])
	})

	test('Alt keys', () => {
		expect(decode('\x1bx')).toEqual(['M-x'])
		expect(decode('\x1b\x7f')).toEqual(['M-backspace'])
	})

	test('editor keys in legacy and kitty forms', () => {
		// Home/End: xterm, SS3, vt220 and rxvt forms, and with modifiers.
		expect(decode('\x1b[H\x1b[F\x1bOH\x1bOF\x1b[1~\x1b[4~\x1b[7~\x1b[8~')).toEqual(['home', 'end', 'home', 'end', 'home', 'end', 'home', 'end'])
		expect(decode('\x1b[1;2H', '\x1b[1;5F')).toEqual(['S-home', 'C-end'])
		expect(decode('\x1b[3~', '\x1b[3;3~')).toEqual(['delete', 'M-delete'])
		// Alt-arrows: xterm modifiers, ESC-prefixed CSI, readline ESC b / ESC f.
		expect(decode('\x1b[1;3D\x1b[1;3C', '\x1b\x1b[D\x1b\x1b[C', '\x1bb\x1bf')).toEqual(['M-left', 'M-right', 'M-left', 'M-right', 'M-left', 'M-right'])
		expect(decode('\x1b\x7f', '\x1b\b', '\x1b[127;3u')).toEqual(['M-backspace', 'M-backspace', 'M-backspace'])
		// Cmd only exists in kitty's modifier bits.
		expect(decode('\x1b[1;9D\x1b[1;9C')).toEqual(['s-left', 's-right'])
		expect(decode('\x0b\x15\x19\x01\x05\x04', '\x1bd')).toEqual(['C-k', 'C-u', 'C-y', 'C-a', 'C-e', 'C-d', 'M-d'])
		expect(decode('\x1b[107;5u\x1b[117;5u\x1b[121;5u\x1b[100;3u')).toEqual(['C-k', 'C-u', 'C-y', 'M-d'])
	})

	test('kitty CSI-u keys', () => {
		expect(decode('\x1b[13u', '\x1b[127u', '\x1b[27u')).toEqual(['enter', 'backspace', 'escape'])
		expect(decode('\x1b[100;5u')).toEqual(['C-d'])
		// Ctrl-M (the model picker) is not Enter only here.
		expect(decode('\x1b[109;5u', '\r')).toEqual(['C-m', 'enter'])
		expect(decode('\x1b[97u')).toEqual(['text:a'])
		expect(decode('\x1b[97;1:3u')).toEqual([]) // key release
	})

	test('bracketed paste is one event and keeps escapes out', () => {
		expect(decode('x\x1b[200~line1\r\nline2\rline3\x1b[201~y')).toEqual([
			'text:x',
			'paste:"line1\\nline2\\nline3"',
			'text:y',
		])
	})

	test('paste with only control-looking bytes stays text', () => {
		expect(decode('\x1b[200~\x04\x7f\x1b[201~')).toEqual(['paste:"\\u0004\x7f"'])
	})
})

describe('unsupported sequences are dropped whole', () => {
	test.each([
		['unknown CSI final', '\x1b[5n'],
		['unknown tilde key', '\x1b[99~'],
		['SGR mouse', '\x1b[<0;10;5M'],
		['OSC reply with BEL', '\x1b]11;rgb:ffff/0000/0000\x07'],
		['OSC reply with ST', '\x1b]11;rgb:ffff/0000/0000\x1b\\'],
		['DCS', '\x1bP>|kitty\x1b\\'],
		['function key via SS3', '\x1bOQ'],
		['kitty private-use key', '\x1b[57441u'],
	])('%s', (_name, seq) => {
		expect(decode(`a${seq}b`)).toEqual(['text:a', 'text:b'])
	})

	test('F1 in its legacy and CSI forms', () => {
		for (let seq of ['\x1bOP', '\x1b[P', '\x1b[1;1P', '\x1b[11~']) expect(decode(seq)).toEqual(['f1'])
	})

	test('malformed CSI does not swallow the following key', () => {
		expect(decode('\x1b[1\rb')).toEqual(['enter', 'text:b'])
	})

	test('no event ever carries an escape byte as text', () => {
		let seqs = ['\x1b[', '\x1b]', '\x1bO', '\x1b[1;', '\x1b[200~', '\x1b[?1u', '\x1b[>1;2c']
		for (let a of seqs)
			for (let b of seqs) {
				let s = keys.createState()
				let evs = [...keys.feed(s, a + b + 'z'), ...keys.flush(s)]
				for (let e of evs) expect(e.text ?? '').not.toContain('\x1b')
			}
	})
})

describe('sequences split across chunks', () => {
	test('every split point of a mixed stream gives the same events', () => {
		let stream = 'a\x1b[1;5C\x1bOB\x1b]11;rgb:0/0/0\x07\x1b[200~p\r\x1b[201~\x1b[100;5u😀\x04'
		let whole = decode(stream)
		expect(whole).toEqual(['text:a', 'C-right', 'down', 'paste:"p\\n"', 'C-d', 'text:😀', 'C-d'])
		let units = [...stream] // split on code points; byte splits are tested below
		for (let i = 1; i < units.length; i++) {
			expect(decode(units.slice(0, i).join(''), units.slice(i).join(''))).toEqual(whole)
		}
		expect(decode(...units)).toEqual(whole)
	})

	test('UTF-8 split inside a code point', () => {
		let b = bytes('é😀')
		for (let i = 1; i < b.length; i++) {
			expect(decode(b.slice(0, i), b.slice(i))).toEqual(['text:é', 'text:😀'])
		}
	})

	test('paste split at every byte, including inside the end marker', () => {
		let b = bytes('\x1b[200~hé\x1b[201~!')
		for (let i = 1; i < b.length; i++) {
			expect(decode(b.slice(0, i), b.slice(i))).toEqual(['paste:"hé"', 'text:!'])
		}
	})

	test('an escape-like prefix inside a paste is kept as pasted text', () => {
		expect(decode('\x1b[200~a\x1b[20', '1x\x1b[201~')).toEqual(['paste:"a\\u001b[201x"'])
	})
})

describe('lone Escape', () => {
	test('trailing ESC waits; flush turns it into Escape', () => {
		let s = keys.createState()
		expect(keys.feed(s, 'a\x1b')).toHaveLength(1)
		expect(keys.pending(s)).toBe(true)
		expect(keys.flush(s).map(show)).toEqual(['escape'])
		expect(keys.pending(s)).toBe(false)
	})

	test('ESC followed later by a CSI tail is the arrow, not Escape', () => {
		expect(decode('\x1b', '[A')).toEqual(['up'])
	})

	test('flush drops an unfinished sequence instead of inserting it', () => {
		let s = keys.createState()
		keys.feed(s, '\x1b]11;rgb:0')
		expect(keys.flush(s)).toEqual([])
		expect(keys.feed(s, 'q').map(show)).toEqual(['text:q'])
	})

	test('flush leaves an unfinished paste pending', () => {
		let s = keys.createState()
		keys.feed(s, '\x1b[200~abc')
		expect(keys.flush(s)).toEqual([])
		expect(keys.feed(s, 'd\x1b[201~').map(show)).toEqual(['paste:"abcd"'])
	})

	test('a paste idle for 5 s is dropped and the next input read as keys', () => {
		let s = keys.createState()
		keys.feed(s, '\x1b[200~lost', 1000)
		keys.feed(s, ' more', 5000)
		// Still open 4.9 s after it last grew.
		expect(keys.feed(s, '!', 9900)).toEqual([])
		expect(keys.feed(s, 'hi\r', 14900).map(show)).toEqual(['text:h', 'text:i', 'enter'])
		expect(keys.feed(s, '\x1b[200~ok\x1b[201~', 14901).map(show)).toEqual(['paste:"ok"'])
	})

	test('double ESC at end flushes as one Alt-Escape', () => {
		let s = keys.createState()
		expect(keys.feed(s, '\x1b\x1b')).toEqual([])
		expect(keys.flush(s).map(show)).toEqual(['M-escape'])
	})
})
