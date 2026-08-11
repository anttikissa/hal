import { describe, expect, test } from 'bun:test'
import { prompt } from './prompt.ts'
import type { KeyEvent } from './keys.ts'

function key(key: string, mods: Partial<KeyEvent> = {}): KeyEvent {
	return { key, shift: false, alt: false, ctrl: false, cmd: false, ...mods }
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

	test('tab leaves a selection alone until multiline indentation is implemented', () => {
		prompt.setText('one\ntwo')
		prompt.handleKey(key('a', { cmd: true }), 80)
		expect(prompt.handleKey(key('tab'), 80)).toBe(false)
		expect(prompt.text()).toBe('one\ntwo')
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
