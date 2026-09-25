import { afterEach, describe, expect, test } from 'bun:test'
import { terminal, type TerminalIO } from './terminal.ts'
import type { KeyEvent } from './keys.ts'

// A fake terminal: records raw mode, output, exits and stops, and lets
// the test type bytes and resume after a stop. Never touches the real tty.
function fixture() {
	let log: string[] = []
	let out = ''
	let raw = false
	let onData: ((chunk: string | Uint8Array) => void) | undefined
	let onContinue: (() => void) | undefined
	let onResize: (() => void) | undefined
	let onExit: (() => void) | undefined
	let io: TerminalIO = {
		setRawMode(on) {
			raw = on
			log.push(on ? 'raw' : 'cooked')
		},
		onData(fn) {
			onData = fn
		},
		write(s) {
			out += s
			log.push('write')
		},
		exit(code) {
			log.push(`exit ${code}`)
		},
		stop() {
			log.push('stop')
		},
		onContinue(fn) {
			onContinue = fn
		},
		onExit(fn) {
			onExit = fn
		},
		size: () => ({ rows: 24, cols: 80 }),
		onResize(fn) {
			onResize = fn
		},
	}
	let keys: KeyEvent[] = []
	let redraws = 0
	terminal.onKeys = (events) => keys.push(...events)
	terminal.redraw = () => redraws++
	terminal.park = () => log.push('park')
	terminal.onResize = () => log.push('resize')
	terminal.init(io)
	return {
		log,
		keys,
		get raw() {
			return raw
		},
		get out() {
			return out
		},
		get redraws() {
			return redraws
		},
		type: (...chunks: (string | Uint8Array)[]) => chunks.forEach((c) => onData!(c)),
		resume: () => onContinue!(),
		resize: () => onResize!(),
		crash: () => onExit!(),
		clearOutput() {
			out = ''
			log.length = 0
		},
	}
}

const defaults = { onKeys: terminal.onKeys, redraw: terminal.redraw, park: terminal.park, onResize: terminal.onResize }
afterEach(() => {
	terminal.reset()
	Object.assign(terminal, defaults)
})

const BRACKETED_PASTE_ON = '\x1b[?2004h'
const BRACKETED_PASTE_OFF = '\x1b[?2004l'

describe('start', () => {
	test('enters raw mode and passes ordinary keys on', () => {
		let t = fixture()
		expect(t.raw).toBe(true)
		expect(t.out).toContain(BRACKETED_PASTE_ON)
		t.type('hi\x1b[A')
		expect(t.keys.map((k) => k.key)).toEqual(['h', 'i', 'up'])
	})

	test('init is idempotent', () => {
		let t = fixture()
		terminal.init({} as TerminalIO)
		t.type('x')
		expect(t.keys.map((k) => k.key)).toEqual(['x'])
	})
})

describe('quit and restart', () => {
	test.each([
		['Ctrl-C', '\x03', 0],
		['kitty Ctrl-C', '\x1b[99;5u', 0],
		['Ctrl-R', '\x12', terminal.restartCode],
		['kitty Ctrl-R', '\x1b[114;5u', terminal.restartCode],
	])('%s restores the terminal, then exits synchronously', (_name, seq, code) => {
		let t = fixture()
		t.clearOutput()
		t.type(seq)
		// Synchronous: already exited when the data handler returns.
		expect(t.log.at(-1)).toBe(`exit ${code}`)
		expect(t.log).toContain('cooked')
		expect(t.raw).toBe(false)
		expect(t.out).toContain(BRACKETED_PASTE_OFF)
		// The last frame stays: no clearing, no alternate screen.
		expect(t.out).not.toMatch(/\x1b\[[23]?J|\x1b\[\?1049|\x1bc/)
	})

	test('restart and quit use different exit codes', () => {
		expect(terminal.restartCode).not.toBe(0)
	})

	test('keys after the emergency key are not delivered', () => {
		let t = fixture()
		t.type('a\x03b')
		expect(t.keys.map((k) => k.key)).toEqual([])
		expect(t.log.filter((l) => l.startsWith('exit'))).toEqual(['exit 0'])
	})

	test('found inside an unfinished paste', () => {
		let t = fixture()
		t.type('\x1b[200~a long paste that never ', 'ends\x03')
		expect(t.log.at(-1)).toBe('exit 0')
	})

	test('found inside a half-read escape sequence', () => {
		let t = fixture()
		t.type('\x1b[1;', '\x12')
		expect(t.log.at(-1)).toBe(`exit ${terminal.restartCode}`)
	})

	test('kitty form split across reads', () => {
		let t = fixture()
		t.type('\x1b[9', '9;', '5u')
		expect(t.log.at(-1)).toBe('exit 0')
	})

	test('a busy key handler cannot delay them', () => {
		let t = fixture()
		terminal.onKeys = () => {
			throw new Error('editor is broken')
		}
		t.type('\x03')
		expect(t.log.at(-1)).toBe('exit 0')
	})
})

describe('suspend', () => {
	test('restores the terminal, stops, and on resume re-enters and redraws', () => {
		let t = fixture()
		t.clearOutput()
		t.type('\x1a')
		expect(t.log.at(-1)).toBe('stop')
		expect(t.log.indexOf('cooked')).toBeLessThan(t.log.indexOf('stop'))
		expect(t.out).toContain(BRACKETED_PASTE_OFF)
		expect(t.redraws).toBe(0)

		t.clearOutput()
		t.resume()
		expect(t.raw).toBe(true)
		expect(t.out).toContain(BRACKETED_PASTE_ON)
		expect(t.redraws).toBe(1)
	})

	test('keys around a suspend still arrive; Ctrl-Z itself does not', () => {
		let t = fixture()
		t.type('a\x1a')
		t.resume()
		t.type('b')
		expect(t.keys.map((k) => k.key)).toEqual(['a', 'b'])
	})

	test('a continue without a suspend does nothing', () => {
		let t = fixture()
		t.resume()
		expect(t.redraws).toBe(0)
	})

	test('kitty Ctrl-Z suspends', () => {
		let t = fixture()
		t.type('\x1b[122;5u')
		expect(t.log.at(-1)).toBe('stop')
	})
})

describe('leaving', () => {
	test.each([
		['quit', '\x03'],
		['restart', '\x12'],
		['suspend', '\x1a'],
	])('%s parks the cursor below the frame before restoring', (_name, seq) => {
		let t = fixture()
		t.clearOutput()
		t.type(seq)
		expect(t.log.indexOf('park')).toBeGreaterThanOrEqual(0)
		expect(t.log.indexOf('park')).toBeLessThan(t.log.indexOf('cooked'))
	})

	test('an exit without quit (crash, signal) still restores the terminal, once', () => {
		let t = fixture()
		t.clearOutput()
		t.crash()
		t.crash()
		expect(t.raw).toBe(false)
		expect(t.out).toContain(BRACKETED_PASTE_OFF)
		expect(t.log.filter((l) => l === 'park' || l === 'cooked')).toEqual(['park', 'cooked'])
	})

	test('a failing park cannot keep the terminal raw', () => {
		let t = fixture()
		terminal.park = () => {
			throw new Error('renderer broke')
		}
		t.type('\x03')
		expect(t.raw).toBe(false)
		expect(t.log.at(-1)).toBe('exit 0')
	})
})

describe('resize', () => {
	test('repaints while we own the terminal, not while suspended', () => {
		let t = fixture()
		t.resize()
		expect(t.log.filter((l) => l === 'resize').length).toBe(1)
		t.type('\x1a')
		t.resize()
		expect(t.log.filter((l) => l === 'resize').length).toBe(1)
	})
})
