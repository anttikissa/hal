import { describe, test, expect, beforeEach } from 'bun:test'
import { readFileSync } from 'fs'
import { clipboard } from '../src/cli/clipboard.ts'
import { prompt } from '../src/cli/prompt.ts'
import type { KeyEvent } from '../src/cli/keys.ts'

function key(key: string, mods: Partial<KeyEvent> = {}): KeyEvent {
	return { key, shift: false, alt: false, ctrl: false, cmd: false, ...mods }
}

beforeEach(() => {
	prompt.clear()
	prompt.setHistory([])
	clipboard.config.multilinePasteFileLineLimit = 5
})

describe('prompt', () => {
	test('shift-enter inserts newline', () => {
		prompt.setText('hello', 5)
		expect(prompt.handleKey(key('enter', { shift: true }), 80)).toBe(true)
		expect(prompt.text()).toBe('hello\n')
	})

	test('pasted multiline buffers below the file line limit stay inline', () => {
		const pasted = 'one\ntwo\nthree\nfour'
		prompt.handleKey({ key: '', char: pasted, shift: false, alt: false, ctrl: false, cmd: false }, 80)
		expect(prompt.text()).toBe(pasted)
		expect(prompt.submitText()).toBe(pasted)
	})

	test('pasted multiline buffers at the file line limit show temp files but keep text for submission', () => {
		const pasted = 'before\ninside\nafter\nline4\nline5'
		prompt.handleKey({ key: '', char: pasted, shift: false, alt: false, ctrl: false, cmd: false }, 80)
		const first = prompt.text()
		expect(first).toMatch(/^\[\/tmp\/hal\/paste\/\d{4}\.txt\]$/)
		expect(readFileSync(first.slice(1, -1), 'utf-8')).toBe(pasted)
		expect(prompt.submitText()).toBe(pasted)

		const secondPaste = 'second\npaste'
		prompt.handleKey({ key: '', char: secondPaste, shift: false, alt: false, ctrl: false, cmd: false }, 80)
		expect(prompt.text()).not.toBe(`${first}${first}`)
		expect(prompt.submitText()).toBe(pasted + secondPaste)
	})

	test('paste file line limit is configurable', () => {
		clipboard.config.multilinePasteFileLineLimit = 3
		const pasted = 'one\ntwo\nthree'
		prompt.handleKey({ key: '', char: pasted, shift: false, alt: false, ctrl: false, cmd: false }, 80)
		expect(prompt.text()).toMatch(/^\[\/tmp\/hal\/paste\/\d{4}\.txt\]$/)
		expect(prompt.submitText()).toBe(pasted)
	})

	test('alt-left and alt-right move by words', () => {
		prompt.setText('hello brave world', 'hello brave world'.length)
		prompt.handleKey(key('left', { alt: true }), 80)
		expect(prompt.cursorPos()).toBe('hello brave '.length)
		prompt.handleKey(key('left', { alt: true }), 80)
		expect(prompt.cursorPos()).toBe('hello '.length)
		prompt.handleKey(key('right', { alt: true }), 80)
		expect(prompt.cursorPos()).toBe('hello brave'.length)
	})

	test('cmd-left and cmd-right move to prompt edges', () => {
		prompt.setText('(hello)', '(hello)'.length - 1)
		prompt.handleKey(key('left', { cmd: true }), 80)
		expect(prompt.cursorPos()).toBe(0)
		prompt.handleKey(key('right', { cmd: true }), 80)
		expect(prompt.cursorPos()).toBe('(hello)'.length)
	})

	test('option-left and option-right stop inside punctuation like Zed', () => {
		prompt.setText('(hello)', '(hello'.length)
		prompt.handleKey(key('left', { alt: true }), 80)
		expect(prompt.cursorPos()).toBe('('.length)
		prompt.handleKey(key('right', { alt: true }), 80)
		expect(prompt.cursorPos()).toBe('(hello'.length)
	})

	test('option-left and option-right match recorded Zed stops', () => {
		const text = '\tx = Math.round(255 * Math.max(0, x * 0.0031308))'
		const leftStops = [48, 40, 38, 36, 34, 32, 31, 27, 22, 20, 16, 10, 5]
		const rightStops = [9, 15, 19, 21, 26, 30, 32, 35, 37, 39, 47, 48]

		prompt.setText(text, text.length)
		for (const stop of leftStops) {
			prompt.handleKey(key('left', { alt: true }), 80)
			expect(prompt.cursorPos()).toBe(stop)
		}

		prompt.setText(text, 5)
		for (const stop of rightStops) {
			prompt.handleKey(key('right', { alt: true }), 80)
			expect(prompt.cursorPos()).toBe(stop)
		}
	})

	test('cmd-a then backspace clears multiline selection', () => {
		prompt.setText('foo\nbar')
		prompt.handleKey(key('a', { cmd: true }), 80)
		prompt.handleKey(key('backspace'), 80)
		expect(prompt.text()).toBe('')
	})

	test('undo and redo keep grouped typing together', () => {
		prompt.handleKey({ key: 'h', char: 'h', shift: false, alt: false, ctrl: false, cmd: false }, 80)
		prompt.handleKey({ key: 'i', char: 'i', shift: false, alt: false, ctrl: false, cmd: false }, 80)
		prompt.handleKey(key('/', { ctrl: true }), 80)
		expect(prompt.text()).toBe('')
		prompt.handleKey(key('/', { ctrl: true, shift: true }), 80)
		expect(prompt.text()).toBe('hi')
	})

	test('ctrl-k kills to yank buffer and ctrl-y yanks it', () => {
		prompt.setText('hello brave world', 'hello '.length)
		prompt.handleKey(key('k', { ctrl: true }), 80)
		expect(prompt.text()).toBe('hello ')
		prompt.setText('say: ', 'say: '.length)
		prompt.handleKey(key('y', { ctrl: true }), 80)
		expect(prompt.text()).toBe('say: brave world')
	})

	test('ctrl-u kills prefix to the same yank buffer', () => {
		prompt.setText('hello brave world', 'hello brave '.length)
		prompt.handleKey(key('u', { ctrl: true }), 80)
		expect(prompt.text()).toBe('world')
		prompt.handleKey(key('e', { ctrl: true }), 80)
		prompt.handleKey(key('y', { ctrl: true }), 80)
		expect(prompt.text()).toBe('worldhello brave ')
	})

	test('up enters history and down restores the draft', () => {
		prompt.setHistory(['older', 'newer'])
		prompt.setText('draft')
		prompt.handleKey(key('up'), 80)
		expect(prompt.text()).toBe('newer')
		prompt.handleKey(key('up'), 80)
		expect(prompt.text()).toBe('older')
		prompt.handleKey(key('down'), 80)
		expect(prompt.text()).toBe('newer')
		prompt.handleKey(key('down'), 80)
		expect(prompt.text()).toBe('draft')
	})

	test('history browsing crosses multiline entries at matching columns', () => {
		prompt.setHistory(['older row one\nxy', 'newer first\nnewer second'])
		prompt.setText('draft top\ndraft bottom', 'draft'.length)

		prompt.handleKey(key('up'), 80)
		expect(prompt.text()).toBe('newer first\nnewer second')
		// Moving up from draft row 0 enters the previous history entry on its
		// bottom row, preserving the visual column we started from.
		expect(prompt.cursorPos()).toBe('newer first\nnewer'.length)

		prompt.handleKey(key('up'), 80)
		expect(prompt.cursorPos()).toBe('newer'.length)

		prompt.handleKey(key('up'), 80)
		expect(prompt.text()).toBe('older row one\nxy')
		// The bottom row is shorter than the goal column, so the same vertical
		// movement clamping used inside a multiline prompt puts us at row end.
		expect(prompt.cursorPos()).toBe('older row one\nxy'.length)

		prompt.handleKey(key('down'), 80)
		expect(prompt.text()).toBe('newer first\nnewer second')
		// Moving down from an older entry enters the newer entry on its first row,
		// not at the end of the whole message, while keeping the goal column.
		expect(prompt.cursorPos()).toBe('newer'.length)
	})

	test('buildPrompt renders multiline cursor position', () => {
		prompt.setText('foo\nbar', 7)
		const built = prompt.buildPrompt(20)
		expect(built.lines).toEqual(['foo', 'bar'])
		expect(built.cursor).toEqual({ rowOffset: 1, col: 3 })
	})

	test('buildPrompt highlights selections across wrapped lines', () => {
		prompt.setText('hello brave world')
		prompt.handleKey(key('a', { cmd: true }), 80)
		const built = prompt.buildPrompt(8)
		expect(built.lines).toEqual(['\x1b[7mhello\x1b[0m', '\x1b[7mbrave\x1b[0m', '\x1b[7mworld\x1b[0m'])
	})

	test('buildPrompt wraps to a new blank line when cursor hits exact width after typing', () => {
		prompt.setText('1234', 4)
		prompt.handleKey({ key: '5', char: '5', shift: false, alt: false, ctrl: false, cmd: false }, 80)
		const built = prompt.buildPrompt(5)
		expect(built.lines).toEqual(['12345', ''])
		expect(built.cursor).toEqual({ rowOffset: 1, col: 0 })
	})
})
