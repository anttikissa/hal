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
	prompt.config.maxPromptLines = 10
	prompt.state.promptLineLimit = 0
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

	test('pasted multiline buffers at the file line limit stay inline', () => {
		const pasted = 'before\ninside\nafter\nline4\nline5'
		prompt.handleKey({ key: '', char: pasted, shift: false, alt: false, ctrl: false, cmd: false }, 80)
		expect(prompt.text()).toBe(pasted)
		expect(prompt.submitText()).toBe(pasted)
	})

	test('pasted multiline buffers over the file line limit show temp files but keep text for submission', () => {
		const pasted = 'before\ninside\nafter\nline4\nline5\nline6'
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
		const atLimit = 'one\ntwo\nthree'
		prompt.handleKey({ key: '', char: atLimit, shift: false, alt: false, ctrl: false, cmd: false }, 80)
		expect(prompt.text()).toBe(atLimit)
		expect(prompt.submitText()).toBe(atLimit)

		prompt.clear()
		const overLimit = 'one\ntwo\nthree\nfour'
		prompt.handleKey({ key: '', char: overLimit, shift: false, alt: false, ctrl: false, cmd: false }, 80)
		expect(prompt.text()).toMatch(/^\[\/tmp\/hal\/paste\/\d{4}\.txt\]$/)
		expect(prompt.submitText()).toBe(overLimit)
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

	test('option movement uses token edges symmetrically around punctuation runs', () => {
		const text = 'foo ### zot'

		prompt.setText(text, 0)
		for (const stop of [3, 7, 11]) {
			prompt.handleKey(key('right', { alt: true }), 80)
			expect(prompt.cursorPos()).toBe(stop)
		}

		prompt.setText(text, text.length)
		for (const stop of [8, 4, 0]) {
			prompt.handleKey(key('left', { alt: true }), 80)
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
		prompt.handleKey(key('z', { cmd: true }), 80)
		expect(prompt.text()).toBe('')
		prompt.handleKey(key('z', { cmd: true, shift: true }), 80)
		expect(prompt.text()).toBe('hi')
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

	test('ctrl-u and ctrl-k operate on current line in multiline text', () => {
		// ctrl-k from middle of first line: kill to end of that line only
		prompt.setText('first line\nsecond line\nthird', 'first '.length)
		prompt.handleKey(key('k', { ctrl: true }), 80)
		expect(prompt.text()).toBe('first \nsecond line\nthird')

		// ctrl-u from middle of second line: kill from start of that line
		const pos = 'first \nsecond '.length
		prompt.setText('first \nsecond line\nthird', pos)
		prompt.handleKey(key('u', { ctrl: true }), 80)
		expect(prompt.text()).toBe('first \nline\nthird')

		// ctrl-k at end-of-line position deletes the newline (joins lines)
		prompt.setText('a\nb', 1)
		prompt.handleKey(key('k', { ctrl: true }), 80)
		expect(prompt.text()).toBe('ab')

		// ctrl-u at start-of-line deletes the preceding newline (joins lines)
		prompt.setText('a\nb', 2)
		prompt.handleKey(key('u', { ctrl: true }), 80)
		expect(prompt.text()).toBe('ab')
	})

	test('ctrl-a and ctrl-e move to current line edges', () => {
		prompt.setText('first\nsecond line\nthird', 'first\nsecond '.length)
		prompt.handleKey(key('a', { ctrl: true }), 80)
		expect(prompt.cursorPos()).toBe('first\n'.length)
		prompt.handleKey(key('e', { ctrl: true }), 80)
		expect(prompt.cursorPos()).toBe('first\nsecond line'.length)
	})

	test('alt-d kills the next word', () => {
		prompt.setText('hello brave world', 'hello '.length)
		prompt.handleKey(key('d', { alt: true }), 80)
		expect(prompt.text()).toBe('hello  world')
		prompt.handleKey(key('y', { ctrl: true }), 80)
		expect(prompt.text()).toBe('hello brave world')
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

	test('history browsing uses the end of the target row for multiline entries', () => {
		prompt.setHistory(['older row one\nxy', 'newer first\nnewer second'])
		prompt.setText('draft top\ndraft bottom', 'draft'.length)

		prompt.handleKey(key('up'), 80)
		expect(prompt.text()).toBe('newer first\nnewer second')
		// Up enters history on the bottom visual row, at that row's end.
		expect(prompt.cursorPos()).toBe('newer first\nnewer second'.length)

		prompt.handleKey(key('up'), 80)
		// Moving within the recalled multiline entry still reaches the previous row.
		expect(prompt.cursorPos()).toBe('newer first'.length)

		prompt.handleKey(key('up'), 80)
		expect(prompt.text()).toBe('older row one\nxy')
		expect(prompt.cursorPos()).toBe('older row one\nxy'.length)

		prompt.handleKey(key('down'), 80)
		expect(prompt.text()).toBe('newer first\nnewer second')
		// Down enters the newer history entry on its top visual row, at row end.
		expect(prompt.cursorPos()).toBe('newer first'.length)
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
		expect(built.lines).toEqual(['\x1b[7mhello\x1b[27m', '\x1b[7mbrave\x1b[27m', '\x1b[7mworld\x1b[27m'])
	})

	test('buildPrompt wraps to a new blank line when cursor hits exact width after typing', () => {
		prompt.setText('1234', 4)
		prompt.handleKey({ key: '5', char: '5', shift: false, alt: false, ctrl: false, cmd: false }, 80)
		const built = prompt.buildPrompt(5)
		expect(built.lines).toEqual(['12345', ''])
		expect(built.cursor).toEqual({ rowOffset: 1, col: 0 })
	})

	test('buildPrompt shows fold indicators for hidden prompt lines', () => {
		prompt.config.maxPromptLines = 3
		prompt.setText('one\ntwo\nthree\nfour', 0)
		expect(prompt.buildPrompt(20).lines).toEqual(['one', 'two', 'three             ↓1'])

		prompt.state.promptLineLimit = 1
		prompt.setText('one\ntwo\nthree', 'one\ntwo'.length)
		expect(prompt.buildPrompt(20).lines).toEqual(['two            ↑1 ↓1'])
	})

	/* ctrl-up/down resize the viewport for composing long prompts without touching text. */
	test('ctrl-up and ctrl-down resize the prompt editing area', () => {
		prompt.config.maxPromptLines = 3
		prompt.state.promptLineLimit = 0
		prompt.setText('one\ntwo\nthree\nfour', 'one\ntwo\nthree\nfour'.length)

		expect(prompt.buildPrompt(20).lines).toEqual(['two               ↑1', 'three', 'four'])
		expect(prompt.handleKey(key('up', { ctrl: true }), 20)).toBe(true)
		expect(prompt.buildPrompt(20).lines).toEqual(['one', 'two', 'three', 'four'])

		expect(prompt.handleKey(key('down', { ctrl: true }), 20)).toBe(true)
		expect(prompt.buildPrompt(20).lines).toEqual(['two               ↑1', 'three', 'four'])
	})
})
