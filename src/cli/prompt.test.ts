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
})
