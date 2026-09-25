import { describe, test, expect } from 'bun:test'
import { keys, type KeyEvent } from './keys.ts'
import { prompt, type PromptState } from './prompt.ts'

// Run raw terminal input through the real decoder and the prompt; returns
// the final state (text with '|' at the cursor) and the actions seen.
function run(input: string, start: PromptState = prompt.empty()): { shown: string; actions: string[] } {
	let events = keys.feed(keys.createState(), input)
	let st = start
	let actions: string[] = []
	for (let k of events) {
		let r = prompt.apply(st, k)
		st = r.state
		if (r.action) actions.push(r.action.type === 'submit' ? `submit:${r.action.text}` : r.action.type)
	}
	return { shown: show(st), actions }
}

function show(st: PromptState): string {
	return st.text.slice(0, st.cursor) + '|' + st.text.slice(st.cursor)
}

function at(text: string, cursor: number): PromptState {
	return { text, cursor }
}

const LEFT = '\x1b[D'
const RIGHT = '\x1b[C'
const BS = '\x7f'
const paste = (s: string) => `\x1b[200~${s}\x1b[201~`

describe('insert', () => {
	test('typing appends at the end', () => {
		expect(run('abc').shown).toBe('abc|')
	})
	test('typing in the middle and at the start', () => {
		expect(run(`ac${LEFT}b`).shown).toBe('ab|c')
		expect(run(`bc${LEFT}${LEFT}a`).shown).toBe('a|bc')
	})
	test('paste inserts everything at the cursor, newlines included', () => {
		expect(run(`ad${LEFT}${paste('b\r\nc')}`).shown).toBe('ab\nc|d')
	})
	test('control and modified keys insert nothing', () => {
		expect(run('a\x01\x1bx\x1b[1;5C').shown).toBe('a|')
	})
})

describe('cursor movement', () => {
	test('left and right stop at both ends', () => {
		expect(run(`ab${LEFT}${LEFT}${LEFT}`).shown).toBe('|ab')
		expect(run(`ab${LEFT}${LEFT}${RIGHT}${RIGHT}${RIGHT}`).shown).toBe('ab|')
	})
})

describe('backspace', () => {
	test('deletes before the cursor at end, middle and start', () => {
		expect(run(`abc${BS}`).shown).toBe('ab|')
		expect(run(`abc${LEFT}${BS}`).shown).toBe('a|c')
		expect(run(`abc${LEFT}${LEFT}${LEFT}${BS}`).shown).toBe('|abc')
	})
})

describe('graphemes are the unit', () => {
	// e + combining acute, a family emoji (ZWJ sequence), a flag
	// (regional-indicator pair) and a skin-toned thumbs up.
	const clusters = ['e\u0301', '👨‍👩‍👧', '🇫🇮', '👍🏽']

	test.each(clusters)('left/right step over %s whole', (g) => {
		let st = at(`a${g}b`, 1)
		st = prompt.apply(st, key('right')).state
		expect(show(st)).toBe(`a${g}|b`)
		st = prompt.apply(st, key('left')).state
		expect(show(st)).toBe(`a|${g}b`)
	})

	test.each(clusters)('backspace deletes %s whole', (g) => {
		expect(run(BS, at(`a${g}b`, 1 + g.length)).shown).toBe('a|b')
		expect(run(BS, at(`${g}`, g.length)).shown).toBe('|')
	})

	test('typed combining mark joins the previous character', () => {
		expect(run(`e\u0301${LEFT}`).shown).toBe('|e\u0301')
	})

	test('cursor never lands inside a cluster after an insert', () => {
		// Typing the second regional indicator in front of an existing one
		// forms a flag with it; the cursor must end up on a boundary.
		let r = prompt.apply(at('🇮', 0), { ...key('x'), key: '🇫', text: '🇫' })
		let bounds = [...new Intl.Segmenter().segment(r.state.text)].map((s) => s.index)
		bounds.push(r.state.text.length)
		expect(r.state.text).toBe('🇫🇮')
		expect(bounds).toContain(r.state.cursor)
	})
})

describe('actions', () => {
	test('Enter submits the text and clears the prompt', () => {
		let r = prompt.apply(at('hi there', 2), key('enter'))
		expect(r.action).toEqual({ type: 'submit', text: 'hi there' })
		expect(show(r.state)).toBe('|')
	})
	test('Escape cancels and keeps the text', () => {
		let r = prompt.apply(at('abc', 1), key('escape'))
		expect(r.action).toEqual({ type: 'cancel' })
		expect(show(r.state)).toBe('a|bc')
	})
	test('Ctrl-D quits only on empty input', () => {
		expect(run('\x04').actions).toEqual(['quit'])
		expect(run('a\x04')).toEqual({ shown: 'a|', actions: [] })
	})
	test('editing keys produce no action', () => {
		expect(run(`ab${LEFT}${BS}c${paste('x')}`).actions).toEqual([])
	})
	test('a whole session through the decoder', () => {
		expect(run(`helo${LEFT}l\r`).actions).toEqual(['submit:hello'])
	})
})

test('apply does not mutate its input state', () => {
	let st = at('abc', 3)
	prompt.apply(st, key('backspace'))
	prompt.apply(st, key('enter'))
	expect(st).toEqual({ text: 'abc', cursor: 3 })
})

function key(name: string): KeyEvent {
	return { key: name, shift: false, alt: false, ctrl: false, cmd: false }
}
