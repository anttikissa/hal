import { describe, test, expect, beforeEach } from 'bun:test'
import { readFileSync } from 'fs'
import { prompt } from '../src/cli/prompt.ts'
import type { KeyEvent } from '../src/cli/keys.ts'

function key(key: string, mods: Partial<KeyEvent> = {}): KeyEvent {
	return { key, shift: false, alt: false, ctrl: false, cmd: false, ...mods }
}

beforeEach(() => {
	prompt.clear()
	prompt.setHistory([])
})

describe('prompt', () => {
	test('shift-enter inserts newline', () => {
		prompt.setText('hello', 5)
		expect(prompt.handleKey(key('enter', { shift: true }), 80)).toBe(true)
		expect(prompt.text()).toBe('hello\n')
	})

	test('pasted multiline buffers show temp files but keep text for submission', () => {
		const pasted = 'before\ninside\nafter'
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
