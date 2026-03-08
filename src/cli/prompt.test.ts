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

	test('reset clears history array', () => {
		prompt.handleKey(key('up'), W)
		expect(prompt.text()).toBe('third')
		prompt.reset()
		// After reset, up should be a no-op (no history)
		prompt.handleKey(key('up'), W)
		expect(prompt.text()).toBe('')
	})

	test('pushHistory after reset makes item available via up arrow', () => {
		prompt.reset()
		prompt.pushHistory('hello')
		prompt.handleKey(key('up'), W)
		expect(prompt.text()).toBe('hello')
	})

	test('submit flow: type, clear, pushHistory, then up recalls it', () => {
		prompt.reset()
		for (const ch of 'hello') prompt.handleKey(key(ch, { char: ch }), W)
		expect(prompt.text()).toBe('hello')

		// Simulate submit: clear() then onSubmit pushes to history
		const submitted = prompt.text()
		prompt.clear()
		prompt.pushHistory(submitted)

		// Now up arrow should recall "hello"
		prompt.handleKey(key('up'), W)
		expect(prompt.text()).toBe('hello')
	})

	test('submit flow: clear then pushHistory makes up arrow work', () => {
		prompt.reset()
		prompt.setHistory([])
		for (const ch of 'hello') prompt.handleKey(key(ch, { char: ch }), W)

		// Simulate keybindings.ts submit flow
		const text = prompt.text().trim()
		prompt.clear()
		prompt.pushHistory(text)

		prompt.handleKey(key('up'), W)
		expect(prompt.text()).toBe('hello')
	})

	test('history survives slash commands (clear preserves history)', () => {
		prompt.reset()
		prompt.setHistory([])

		// Submit a regular prompt
		for (const ch of 'hello') prompt.handleKey(key(ch, { char: ch }), W)
		prompt.clear()
		prompt.pushHistory('hello')

		// Submit a slash command (clear without pushHistory)
		for (const ch of '/model x') prompt.handleKey(key(ch, { char: ch }), W)
		prompt.clear()

		// History should still have "hello"
		prompt.handleKey(key('up'), W)
		expect(prompt.text()).toBe('hello')
	})
})

describe('ctrl+a / ctrl+e (home/end)', () => {
	beforeEach(() => prompt.reset())

	test('ctrl+a moves cursor to start', () => {
		for (const ch of 'hello') prompt.handleKey(key(ch, { char: ch }), W)
		// Cursor is at end (pos 5)
		prompt.handleKey(key('a', { ctrl: true }), W)
		// Type a char — should insert at position 0
		prompt.handleKey(key('X', { char: 'X' }), W)
		expect(prompt.text()).toBe('Xhello')
	})

	test('ctrl+e moves cursor to end', () => {
		for (const ch of 'hello') prompt.handleKey(key(ch, { char: ch }), W)
		// Move to start first
		prompt.handleKey(key('a', { ctrl: true }), W)
		// Now ctrl+e to end
		prompt.handleKey(key('e', { ctrl: true }), W)
		prompt.handleKey(key('!', { char: '!' }), W)
		expect(prompt.text()).toBe('hello!')
	})
})