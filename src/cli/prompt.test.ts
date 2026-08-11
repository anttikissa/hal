import { describe, expect, test } from 'bun:test'
import { prompt } from './prompt.ts'
import type { KeyEvent } from './keys.ts'

function key(key: string, mods: Partial<KeyEvent> = {}): KeyEvent {
	return { key, shift: false, alt: false, ctrl: false, cmd: false, ...mods }
}

function select(text: string, anchor: number, cursor: number): void {
	prompt.setText(text, cursor)
	prompt.restoreState({ ...prompt.snapshotState(), selAnchor: anchor })
}

describe('prompt editor', () => {
	test('ctrl-= and ctrl-- resize the prompt editor height', () => {
		prompt.setText('one\ntwo')
		prompt.config.maxPromptLines = 10
		prompt.state.promptLineLimit = 0

		expect(prompt.buildPrompt(80).lines.length).toBe(2)
		expect(prompt.handleKey(key('=', { ctrl: true }), 80)).toBe(true)
		expect(prompt.promptLineLimit()).toBe(3)
		expect(prompt.buildPrompt(80).lines.length).toBe(3)

		expect(prompt.handleKey(key('-', { ctrl: true }), 80)).toBe(true)
		expect(prompt.buildPrompt(80).lines.length).toBe(2)
		expect(prompt.state.promptLineLimit).toBe(0)
	})

	test('selection rendering does not reset prompt background before row padding', () => {
		prompt.setText('one\ntwo\nthree')
		prompt.handleKey(key('a', { cmd: true }), 80)

		const line = prompt.buildPrompt(80).lines[0]!
		expect(line).toContain('\x1b[7m')
		expect(line).toContain('\x1b[27m')
		expect(line).not.toContain('\x1b[0m')
		prompt.clear()
	})

	test('selected tabs render as styled spaces through the next tab stop', () => {
		prompt.setText('a\tb', 1)
		prompt.handleKey(key('right', { shift: true }), 80)
		expect(prompt.buildPrompt(80).lines).toEqual(['a\x1b[7m   \x1b[27mb'])
		prompt.clear()
	})

	test('cursor stays in right padding when text exactly fills prompt row', () => {
		prompt.setText('abcd')

		const built = prompt.buildPrompt(4)

		expect(built.lines).toEqual(['abcd'])
		expect(built.cursor).toEqual({ rowOffset: 0, col: 4 })
		prompt.clear()
	})

	test('tab keeps a literal tab in the prompt and displays a four-column stop', () => {
		prompt.setText('ab')
		expect(prompt.handleKey(key('tab'), 80)).toBe(true)
		expect(prompt.text()).toBe('ab\t')
		expect(prompt.buildPrompt(80)).toMatchObject({ lines: ['ab  '], cursor: { rowOffset: 0, col: 4 } })
		prompt.clear()
	})

	test('up preserves visual column across tab-indented lines', () => {
		prompt.setText('\tif\n\t\tprintf', '\tif\n'.length)
		prompt.handleKey(key('up'), 80)
		expect(prompt.cursorPos()).toBe(0)
		prompt.clear()
	})

	test('vertical movement chooses the nearest edge of a tab', () => {
		prompt.setText('\tX\nabc', '\tX\nabc'.length)
		prompt.handleKey(key('up'), 80)
		expect(prompt.cursorPos()).toBe(1)
		prompt.clear()
	})

	test('tabs participate in prompt wrapping at their displayed width', () => {
		prompt.setText('abc\tX')
		expect(prompt.buildPrompt(4).lines).toEqual(['abc ', 'X'])
		prompt.clear()
	})

	test('tab indents every selected logical row and keeps selection offsets for undo', () => {
		select('one\ntwo\nthree', 1, 6)
		expect(prompt.handleKey(key('tab'), 80)).toBe(true)
		expect(prompt.text()).toBe('\tone\n\ttwo\nthree')
		expect(prompt.snapshotState()).toMatchObject({ cursor: 8, selAnchor: 2 })

		prompt.handleKey(key('z', { cmd: true }), 80)
		expect(prompt.text()).toBe('one\ntwo\nthree')
		expect(prompt.snapshotState()).toMatchObject({ cursor: 6, selAnchor: 1 })
		prompt.clear()
	})

	test('tab excludes a row touched only by the selection endpoint', () => {
		select('one\ntwo', 1, 4)
		prompt.handleKey(key('tab'), 80)
		expect(prompt.text()).toBe('\tone\ntwo')
		expect(prompt.snapshotState()).toMatchObject({ cursor: 5, selAnchor: 2 })
		prompt.clear()
	})

	test('shift-tab deindents selected rows by one four-column level', () => {
		const text = '\tone\n  \ttwo\n   three\nfour'
		select(text, text.length, 0)
		expect(prompt.handleKey(key('tab', { shift: true }), 80)).toBe(true)
		expect(prompt.text()).toBe('one\ntwo\nthree\nfour')
		expect(prompt.snapshotState()).toMatchObject({ cursor: 0, selAnchor: prompt.text().length })

		prompt.handleKey(key('z', { cmd: true }), 80)
		expect(prompt.text()).toBe(text)
		expect(prompt.snapshotState()).toMatchObject({ cursor: 0, selAnchor: text.length })
		prompt.clear()
	})

	test('shift-tab deindents the current logical row without a selection', () => {
		prompt.setText('one\n  two', 'one\n  tw'.length)
		expect(prompt.handleKey(key('tab', { shift: true }), 80)).toBe(true)
		expect(prompt.text()).toBe('one\ntwo')
		expect(prompt.cursorPos()).toBe('one\ntw'.length)
		prompt.clear()
	})

	test('history recall places the cursor at the visual row end', () => {
		prompt.setHistory(['界界X'])
		prompt.setText('')
		prompt.handleKey(key('up'), 80)
		expect(prompt.cursorPos()).toBe(3)
		prompt.setHistory([])
		prompt.clear()
	})

	test('down keeps existing prompt viewport when cursor remains visible', () => {
		prompt.config.maxPromptLines = 10
		prompt.state.promptLineLimit = 3
		prompt.setText('one\ntwo\nthree\nfour\nfive\nsix\nseven\neight', 'one\ntwo\nthree\nfour\n'.length)
		prompt.state.promptScrollTop = 4

		const before = prompt.buildPrompt(80)
		expect(before.lines[0]!).toStartWith('five')
		expect(before.cursor.rowOffset).toBe(0)

		expect(prompt.handleKey(key('down'), 80)).toBe(true)
		const after = prompt.buildPrompt(80)
		expect(after.lines[0]!).toStartWith('five')
		expect(after.cursor.rowOffset).toBe(1)

		prompt.clear()
		prompt.state.promptLineLimit = 0
	})
})
