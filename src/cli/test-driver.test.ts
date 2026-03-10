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

	test('shift+up at first line selects to beginning', () => {
		d.type('hello world')
		// Cursor is at end (pos 11). Single line, so up is already at boundary.
		d.press('up', { shift: true })
		expect(d.selection).toEqual([0, 11])
		expect(d.cursor).toBe(0)
	})

	test('shift+down at last line selects to end', () => {
		d.type('hello world')
		// Move cursor to beginning first
		d.press('a', { ctrl: true })
		expect(d.cursor).toBe(0)
		d.press('down', { shift: true })
		expect(d.selection).toEqual([0, 11])
		expect(d.cursor).toBe(11)
	})

	test('shift+up in multiline selects to beginning from first line', () => {
		d.type('line one')
		d.press('enter', { shift: true }) // newline
		d.type('line two')
		// Cursor at end of line 2. shift+up should move up one line first.
		d.press('up', { shift: true })
		// Now on first line — shift+up again should select to pos 0
		d.press('up', { shift: true })
		expect(d.cursor).toBe(0)
		expect(d.selection).toEqual([0, 17]) // 'line one\nline two' = 17 chars, anchor at 17
	})
})

describe('ctrl-k (kill to end of line)', () => {
	test('deletes from cursor to end of line', () => {
		d.type('hello world')
		d.press('a', { ctrl: true }) // move to start
		d.press('right') // pos 1
		d.press('right') // pos 2
		d.press('right') // pos 3
		d.press('right') // pos 4
		d.press('right') // pos 5
		expect(d.cursor).toBe(5)
		d.press('k', { ctrl: true })
		expect(d.promptText).toBe('hello')
		expect(d.cursor).toBe(5)
	})

	test('at end of line does nothing', () => {
		d.type('hello')
		expect(d.cursor).toBe(5)
		d.press('k', { ctrl: true })
		expect(d.promptText).toBe('hello')
	})

	test('at beginning kills entire line', () => {
		d.type('hello')
		d.press('a', { ctrl: true })
		d.press('k', { ctrl: true })
		expect(d.promptText).toBe('')
		expect(d.cursor).toBe(0)
	})

	test('does not crash', () => {
		d.type('hello')
		expect(() => d.press('k', { ctrl: true })).not.toThrow()
	})
})

describe('word jump (alt+left/right)', () => {
	test('alt+left jumps to previous word boundary', () => {
		d.type('hello world foo')
		d.press('left', { alt: true })
		expect(d.cursor).toBe(12) // before 'foo'
		d.press('left', { alt: true })
		expect(d.cursor).toBe(6) // before 'world'
		d.press('left', { alt: true })
		expect(d.cursor).toBe(0) // before 'hello'
	})

	test('alt+right jumps to next word boundary', () => {
		d.type('hello world foo')
		d.press('a', { ctrl: true }) // go to start
		d.press('right', { alt: true })
		expect(d.cursor).toBe(5) // after 'hello'
		d.press('right', { alt: true })
		expect(d.cursor).toBe(11) // after 'world'
		d.press('right', { alt: true })
		expect(d.cursor).toBe(15) // after 'foo'
	})

	test('alt+left at start stays at 0', () => {
		d.type('hello')
		d.press('a', { ctrl: true })
		d.press('left', { alt: true })
		expect(d.cursor).toBe(0)
	})

	test('alt+right at end stays at end', () => {
		d.type('hello')
		d.press('right', { alt: true })
		expect(d.cursor).toBe(5)
	})
})

describe('delete word (alt+backspace)', () => {
	test('deletes previous word', () => {
		d.type('hello world')
		d.press('backspace', { alt: true })
		expect(d.promptText).toBe('hello ')
	})

	test('deletes multiple words one at a time', () => {
		d.type('one two three')
		d.press('backspace', { alt: true })
		expect(d.promptText).toBe('one two ')
		d.press('backspace', { alt: true })
		expect(d.promptText).toBe('one ')
		d.press('backspace', { alt: true })
		expect(d.promptText).toBe('')
	})

	test('at start does nothing', () => {
		d.type('hello')
		d.press('a', { ctrl: true })
		d.press('backspace', { alt: true })
		expect(d.promptText).toBe('hello')
	})
})

describe('ctrl-u (delete to start)', () => {
	test('deletes from cursor to start', () => {
		d.type('hello world')
		d.press('left', { alt: true }) // before 'world'
		d.press('u', { ctrl: true })
		expect(d.promptText).toBe('world')
		expect(d.cursor).toBe(0)
	})

	test('at start does nothing', () => {
		d.type('hello')
		d.press('a', { ctrl: true })
		d.press('u', { ctrl: true })
		expect(d.promptText).toBe('hello')
	})

	test('at end deletes everything', () => {
		d.type('hello')
		d.press('u', { ctrl: true })
		expect(d.promptText).toBe('')
		expect(d.cursor).toBe(0)
	})
})

describe('multiline editing', () => {
	test('shift+enter inserts newline', () => {
		d.type('line one')
		d.press('enter', { shift: true })
		d.type('line two')
		expect(d.promptText).toBe('line one\nline two')
	})

	test('up/down navigates within multiline content', () => {
		d.type('aaa')
		d.press('enter', { shift: true })
		d.type('bbb')
		d.press('enter', { shift: true })
		d.type('ccc')
		// Cursor at end of line 3. Up should go to line 2.
		d.press('up')
		expect(d.cursor).toBeLessThan(8) // somewhere in 'bbb'
		d.press('up')
		expect(d.cursor).toBeLessThan(4) // somewhere in 'aaa'
	})

	test('up at first line of multiline enters history', () => {
		d.submit('previous msg')
		d.type('aaa')
		d.press('enter', { shift: true })
		d.type('bbb')
		d.press('up') // line 2 → line 1
		d.press('up') // boundary → history
		expect(d.promptText).toBe('previous msg')
	})
})