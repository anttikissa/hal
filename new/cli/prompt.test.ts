import { describe, test, expect, beforeEach } from 'bun:test'
import * as prompt from './prompt.ts'
import type { KeyEvent } from './keys.ts'

function key(k: string, mods: Partial<KeyEvent> = {}): KeyEvent {
	return { key: k, char: '', ctrl: false, alt: false, shift: false, cmd: false, ...mods }
}

const W = 80

describe('prompt history', () => {
	beforeEach(() => {
		prompt.reset()
		prompt.setHistory(['first', 'second', 'third'])
	})

	test('up arrow cycles through history (newest first)', () => {
		prompt.handleKey(key('up'), W)
		expect(prompt.text()).toBe('third')

		prompt.handleKey(key('up'), W)
		expect(prompt.text()).toBe('second')

		prompt.handleKey(key('up'), W)
		expect(prompt.text()).toBe('first')
	})

	test('up then down returns to draft', () => {
		// Type something first
		prompt.handleKey(key('x', { char: 'x' }), W)
		expect(prompt.text()).toBe('x')

		prompt.handleKey(key('up'), W)
		expect(prompt.text()).toBe('third')

		prompt.handleKey(key('down'), W)
		expect(prompt.text()).toBe('x')
	})

	test('up at oldest stays', () => {
		prompt.handleKey(key('up'), W)
		prompt.handleKey(key('up'), W)
		prompt.handleKey(key('up'), W)
		expect(prompt.text()).toBe('first')

		// One more up should stay at oldest
		prompt.handleKey(key('up'), W)
		expect(prompt.text()).toBe('first')
	})

	test('down without history browsing is no-op', () => {
		prompt.handleKey(key('down'), W)
		expect(prompt.text()).toBe('')
	})

	test('empty history: up/down are no-ops', () => {
		prompt.setHistory([])
		prompt.handleKey(key('up'), W)
		expect(prompt.text()).toBe('')
		prompt.handleKey(key('down'), W)
		expect(prompt.text()).toBe('')
	})

	test('setText resets history browsing', () => {
		prompt.handleKey(key('up'), W)
		expect(prompt.text()).toBe('third')

		prompt.setText('override')
		prompt.handleKey(key('up'), W)
		expect(prompt.text()).toBe('third')
	})

	test('reset clears history browsing', () => {
		prompt.handleKey(key('up'), W)
		prompt.reset()
		prompt.setHistory(['a', 'b'])
		prompt.handleKey(key('up'), W)
		expect(prompt.text()).toBe('b')
	})
})
