import { describe, test, expect, beforeEach } from 'bun:test'
import { TestDriver } from './test-driver.ts'

let d: TestDriver

beforeEach(() => { d = new TestDriver() })

describe('TestDriver', () => {
	test('type sets prompt text', () => {
		d.type('hello')
		expect(d.promptText).toBe('hello')
		expect(d.cursor).toBe(5)
	})

	test('submit sends prompt command', () => {
		d.submit('hello world')
		expect(d.sent).toEqual([{ type: 'prompt', text: 'hello world' }])
		expect(d.promptText).toBe('')
	})

	test('submit slash command sends command', () => {
		d.submit('/reset')
		expect(d.sent).toEqual([{ type: 'reset', text: undefined }])
	})

	test('ctrl-t sends open', () => {
		d.press('t', { ctrl: true })
		expect(d.sent).toEqual([{ type: 'open', text: undefined }])
	})

	test('ctrl-f sends fork', () => {
		d.press('f', { ctrl: true })
		expect(d.sent).toEqual([{ type: 'fork', text: undefined }])
	})

	test('typing and cursor position', () => {
		d.type('hello')
		expect(d.cursor).toBe(5)
		d.press('a', { ctrl: true }) // home
		expect(d.cursor).toBe(0)
		d.press('e', { ctrl: true }) // end
		expect(d.cursor).toBe(5)
	})

	test('reset clears state', () => {
		d.type('hello')
		d.enter()
		expect(d.sent.length).toBeGreaterThan(0)
		d.reset()
		expect(d.sent).toEqual([])
		expect(d.promptText).toBe('')
		expect(d.renders).toBe(0)
	})

	test('renders are counted', () => {
		d.type('a')
		expect(d.renders).toBeGreaterThan(0)
	})

	test('arrow keys navigate prompt', () => {
		d.type('abc')
		d.press('left')
		expect(d.cursor).toBe(2)
		d.press('left')
		expect(d.cursor).toBe(1)
		d.press('right')
		expect(d.cursor).toBe(2)
	})
})

describe('history navigation', () => {
	test('up arrow recalls submitted messages in reverse order', () => {
		d.submit('foo')
		d.submit('bar')
		d.submit('zot')

		d.press('up')
		expect(d.promptText).toBe('zot')
		d.press('up')
		expect(d.promptText).toBe('bar')
		d.press('up')
		expect(d.promptText).toBe('foo')
	})

	test('each message appears exactly once (no duplicates)', () => {
		d.submit('foo')
		d.submit('bar')
		d.submit('zot')

		// Walk all the way up: zot, bar, foo
		d.press('up')
		expect(d.promptText).toBe('zot')
		d.press('up')
		expect(d.promptText).toBe('bar')
		d.press('up')
		expect(d.promptText).toBe('foo')
		// One more up stays at oldest
		d.press('up')
		expect(d.promptText).toBe('foo')
	})

	test('down arrow walks back toward newest, then to empty', () => {
		d.submit('foo')
		d.submit('bar')

		d.press('up')
		d.press('up')
		expect(d.promptText).toBe('foo')

		d.press('down')
		expect(d.promptText).toBe('bar')
		d.press('down')
		expect(d.promptText).toBe('')
	})

	test('shared array has exactly one entry per submit', () => {
		d.submit('foo')
		d.submit('bar')
		d.submit('zot')
		expect(d.inputHistory).toEqual(['foo', 'bar', 'zot'])
	})
})