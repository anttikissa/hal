import { describe, test, expect, beforeEach } from 'bun:test'
import { readFileSync } from 'fs'
import { clipboard } from '../src/client/terminal/clipboard.ts'
import { prompt } from '../src/client/terminal/prompt.ts'
import type { KeyEvent } from '../src/client/terminal/keys.ts'

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

	test('setHistory does not let caller appends duplicate prompt recall', () => {
		const inputHistory = ['older']
		prompt.setHistory(inputHistory)

		// The CLI echoes a just-submitted prompt into the editor history for
		// immediate up-arrow recall, then appends the same prompt to the tab's
		// inputHistory. These are separate owners; sharing the same array makes the
		// just-sent prompt appear twice while editing it.
		prompt.pushHistory('hello')
		inputHistory.push('hello')
		prompt.setText('hello')

		prompt.handleKey(key('up'), 80)
		expect(prompt.text()).toBe('older')
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

	test('buildPrompt highlights selections across wrapped lines', () => {
		prompt.setText('hello brave world')
		prompt.handleKey(key('a', { cmd: true }), 80)
		const built = prompt.buildPrompt(8)
		expect(built.lines).toEqual(['\x1b[7mhello\x1b[27m', '\x1b[7mbrave\x1b[27m', '\x1b[7mworld\x1b[27m'])
	})

	test('buildPrompt keeps the cursor in right padding when text hits exact width after typing', () => {
		prompt.setText('1234', 4)
		prompt.handleKey({ key: '5', char: '5', shift: false, alt: false, ctrl: false, cmd: false }, 80)
		const built = prompt.buildPrompt(5)
		expect(built.lines).toEqual(['12345'])
		expect(built.cursor).toEqual({ rowOffset: 0, col: 5 })
	})

	test('prompt wraps a trailing space at exact row width', () => {
		prompt.setText('12345', 5)
		prompt.handleKey({ key: ' ', char: ' ', shift: false, ctrl: false, alt: false, cmd: false }, 5)

		const built = prompt.buildPrompt(5)
		expect(built.lines).toEqual(['12345', ''])
		expect(built.cursor).toEqual({ rowOffset: 1, col: 0 })
	})

	test('cursor position survives newline after a wrapped trailing space', () => {
		prompt.setText('12345', 5)
		prompt.handleKey({ key: ' ', char: ' ', shift: false, ctrl: false, alt: false, cmd: false }, 5)
		prompt.handleKey(key('enter', { shift: true }), 5)
		prompt.handleKey({ key: 'a', char: 'a', shift: false, ctrl: false, alt: false, cmd: false }, 5)

		const built = prompt.buildPrompt(5)
		expect(built.lines).toEqual(['12345', '', 'a'])
		expect(built.cursor).toEqual({ rowOffset: 2, col: 1 })
	})

	test('small square advances the prompt cursor by one column', () => {
		prompt.setText('a▪b', 1)
		prompt.handleKey(key('right'), 10)
		const built = prompt.buildPrompt(10)

		expect(prompt.cursorPos()).toBe(2)
		expect(built.cursor).toEqual({ rowOffset: 0, col: 2 })
	})

	test('buildPrompt reports hidden prompt lines', () => {
		prompt.config.maxPromptLines = 3
		prompt.setText('one\ntwo\nthree\nfour', 0)
		let built = prompt.buildPrompt(20)
		expect(built.lines).toEqual(['one', 'two', 'three'])
		expect(built.fold).toEqual({ above: 0, below: 1 })

		prompt.state.promptLineLimit = 1
		prompt.setText('one\ntwo\nthree', 'one\ntwo'.length)
		built = prompt.buildPrompt(20)
		expect(built.lines).toEqual(['two'])
		expect(built.fold).toEqual({ above: 1, below: 1 })
	})

	/* ctrl-up/down resize the viewport for composing long prompts without touching text. */
	test('ctrl-up and ctrl-down resize the prompt editing area', () => {
		prompt.config.maxPromptLines = 3
		prompt.state.promptLineLimit = 0
		prompt.setText('one\ntwo\nthree\nfour', 'one\ntwo\nthree\nfour'.length)

		expect(prompt.buildPrompt(20).lines).toEqual(['two', 'three', 'four'])
		expect(prompt.handleKey(key('up', { ctrl: true }), 20)).toBe(true)
		expect(prompt.buildPrompt(20).lines).toEqual(['one', 'two', 'three', 'four'])

		expect(prompt.handleKey(key('down', { ctrl: true }), 20)).toBe(true)
		expect(prompt.buildPrompt(20).lines).toEqual(['two', 'three', 'four'])
	})
})
