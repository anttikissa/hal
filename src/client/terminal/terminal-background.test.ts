import { afterEach, describe, expect, test } from 'bun:test'
import { terminalOutput } from './terminal-output.ts'
import { terminalBackground } from './terminal-background.ts'

afterEach(() => terminalBackground.reset())

describe('terminalBackground', () => {
	test('queries OSC 11 once without blocking', () => {
		const oldWrite = terminalOutput.write
		const writes: string[] = []
		terminalOutput.write = (text) => {
			writes.push(text)
			return true
		}
		try {
			terminalBackground.query()
			terminalBackground.query()
			expect(writes).toEqual(['\x1b]11;?\x1b\\'])
			expect(terminalBackground.state.background).toBeNull()
		} finally {
			terminalOutput.write = oldWrite
		}
	})

	test('consumes OSC 11 replies split at every boundary', () => {
		const reply = '\x1b]11;rgb:1234/5678/9abc\x1b\\'
		for (let i = 0; i <= reply.length; i++) {
			terminalBackground.reset()
			expect(terminalBackground.consume(reply.slice(0, i))).toBe('')
			expect(terminalBackground.consume(reply.slice(i))).toBe('')
			expect(terminalBackground.state.background).toEqual([18, 86, 154])
		}
	})

	test('accepts BEL terminators and consumes malformed OSC 11 replies', () => {
		expect(terminalBackground.consume('\x1b]11;rgb:ff/00/80\x07x')).toBe('x')
		expect(terminalBackground.state.background).toEqual([255, 0, 128])
		expect(terminalBackground.consume('\x1b]11;rgb:wrong\x1b\\y')).toBe('y')
		expect(terminalBackground.state.background).toEqual([255, 0, 128])
	})

	test('passes ordinary input through, including Escape after a deferred prefix flush', () => {
		expect(terminalBackground.consume('abc\x1b[A')).toBe('abc\x1b[A')
		expect(terminalBackground.consume('\x1b')).toBe('')
		expect(terminalBackground.flush()).toBe('\x1b')
	})

	test('does not treat an OSC-looking bracketed paste as a terminal reply', () => {
		const pasted = '\x1b[200~before\x1b]11;rgb:0000/0000/0000\x1b\\after\x1b[201~'
		expect(terminalBackground.consume(pasted)).toBe(pasted)
		expect(terminalBackground.state.background).toBeNull()
	})

	test('bounds an unterminated OSC 11 reply', () => {
		terminalBackground.consume(`\x1b]11;${'x'.repeat(1025)}`)
		expect(terminalBackground.state.partial).toBe('')
		expect(terminalBackground.consume('z')).toBe('z')
	})
})


test('split paste delimiters preserve input, while a truncated reply times out silently', () => {
	const paste = '\x1b[200~\x1b]11;rgb:ff/ff/ff\x07\x1b[201~'
	let output = ''
	for (const character of paste) output += terminalBackground.consume(character)
	expect(output).toBe(paste)
	expect(terminalBackground.state.background).toBeNull()
	terminalBackground.consume('\x1b]11;rgb:ff/')
	expect(terminalBackground.flushDelay()).toBe(1000)
	expect(terminalBackground.flush()).toBe('')
	expect(terminalBackground.consume('hello')).toBe('hello')
})
