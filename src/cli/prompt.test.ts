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
		expect(prompt.promptLineLimit()).toBe(7)
		expect(prompt.buildPrompt(80).lines.length).toBe(7)

		expect(prompt.handleKey(key('-', { ctrl: true }), 80)).toBe(true)
		expect(prompt.buildPrompt(80).lines.length).toBe(2)
		expect(prompt.state.promptLineLimit).toBe(0)
	})
})
