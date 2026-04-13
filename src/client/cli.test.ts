import { expect, test } from 'bun:test'
import { cli } from './cli.ts'

function makeRawSink(): { lines: string[]; emit: (text: string) => void } {
	const lines: string[] = []
	return { lines, emit: (text) => lines.push(text) }
}

test('read-only slash commands never route through steering', () => {
	expect(cli.submitCommandType('/help', false)).toBe('prompt')
	expect(cli.submitCommandType('/help', true)).toBe('prompt')
})

test('model changes steer while busy so the old turn gets aborted first', () => {
	expect(cli.submitCommandType('/model gpt-5.4', false)).toBe('prompt')
	expect(cli.submitCommandType('/model gpt-5.4', true)).toBe('steer')
})

test('normal prompts steer only while busy', () => {
	expect(cli.submitCommandType('hello', false)).toBe('prompt')
	expect(cli.submitCommandType('hello', true)).toBe('steer')
})

test('raw formatter keeps printable ascii readable', () => {
	expect(cli.formatRawToken('a')).toBe("'a'")
	expect(cli.formatRawToken(' ')).toBe("' '")
	expect(cli.formatRawToken("'")).toBe("'\\\''")
})

test('raw formatter shows escape sequences as hex bytes', () => {
	expect(cli.formatRawToken('\x1b[27;2;13~')).toBe('[0x1b 0x5b 0x32 0x37 0x3b 0x32 0x3b 0x31 0x33 0x7e]')
})

test('raw mode coalesces tokens and exits on escape', () => {
	const sink = makeRawSink()
	cli.rawModeForTests.reset()
	cli.rawModeForTests.start(sink.emit)
	expect(cli.rawModeForTests.handle('ab\x1b[27;2;13~', sink.emit)).toBe(true)
	cli.rawModeForTests.flush(sink.emit)
	expect(sink.lines).toEqual([
		'Raw input mode on. Press Esc to exit.',
		"'a' 'b' [0x1b 0x5b 0x32 0x37 0x3b 0x32 0x3b 0x31 0x33 0x7e]",
	])
	
	expect(cli.rawModeForTests.handle('\x1b', sink.emit)).toBe(true)
	expect(sink.lines.at(-1)).toBe('Raw input mode off.')
	expect(cli.rawModeForTests.active()).toBe(false)
})
