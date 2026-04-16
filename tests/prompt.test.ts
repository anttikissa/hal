import { describe, test, expect, beforeEach } from 'bun:test'
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

	test('alt-left and alt-right move by words', () => {
		prompt.setText('hello brave world', 'hello brave world'.length)
		prompt.handleKey(key('left', { alt: true }), 80)
		expect(prompt.cursorPos()).toBe('hello brave '.length)
		prompt.handleKey(key('left', { alt: true }), 80)
		expect(prompt.cursorPos()).toBe('hello '.length)
		prompt.handleKey(key('right', { alt: true }), 80)
		expect(prompt.cursorPos()).toBe('hello brave'.length)
	})

	test('cmd-a then backspace clears multiline selection', () => {
		prompt.setText('foo\nbar')
		prompt.handleKey(key('a', { cmd: true }), 80)
		prompt.handleKey(key('backspace'), 80)
		expect(prompt.text()).toBe('')
	})

	test('undo reverts grouped typing', () => {
		prompt.handleKey({ key: 'h', char: 'h', shift: false, alt: false, ctrl: false, cmd: false }, 80)
		prompt.handleKey({ key: 'i', char: 'i', shift: false, alt: false, ctrl: false, cmd: false }, 80)
		prompt.handleKey(key('/', { ctrl: true }), 80)
		expect(prompt.text()).toBe('')
	})

	test('buildPrompt renders multiline cursor position', () => {
		prompt.setText('foo\nbar', 7)
		const built = prompt.buildPrompt(20)
		expect(built.lines).toEqual(['foo', 'bar'])
		expect(built.cursor).toEqual({ rowOffset: 1, col: 3 })
	})

	test('buildPrompt wraps to a new blank line when cursor is at exact width', () => {
		prompt.setText('12345', 5)
		const built = prompt.buildPrompt(5)
		expect(built.lines).toEqual(['12345', ''])
		expect(built.cursor).toEqual({ rowOffset: 1, col: 0 })
		expect(built.lines).toHaveLength(2)
	})
})
