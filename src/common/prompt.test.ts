import { describe, test, expect } from 'bun:test'
import type { Key } from './forms.ts'
import { prompt, type PromptState } from './prompt.ts'

// '|' marks the cursor in both the input and the expected text.
function at(marked: string, kill?: string): PromptState {
	let cursor = marked.indexOf('|')
	let st: PromptState = { text: marked.slice(0, cursor) + marked.slice(cursor + 1), cursor }
	return kill === undefined ? st : { ...st, kill }
}

function show(st: PromptState): string {
	return st.text.slice(0, st.cursor) + '|' + st.text.slice(st.cursor)
}

// Key names with emacs-style prefixes: C- ctrl, M- alt, s- cmd.
function key(name: string): Key {
	let k: Key = { key: name }
	for (;;) {
		let m = /^([CMs])-(.+)$/.exec(k.key)
		if (!m) return k
		k = { ...k, key: m[2]!, ...(m[1] === 'C' ? { ctrl: true } : m[1] === 'M' ? { alt: true } : { cmd: true }) }
	}
}

function press(marked: string, ...names: string[]): PromptState {
	let st = at(marked)
	for (let n of names) st = prompt.step(st, key(n)).state
	return st
}

const cases: [string, string, string][] = [
	// Grapheme moves and deletes.
	['a|e\u0301b', 'right', 'ae\u0301|b'],
	['a👨‍👩‍👧|b', 'left', 'a|👨‍👩‍👧b'],
	['a|🇫🇮b', 'delete', 'a|b'],
	['ab|', 'delete', 'ab|'],
	['|ab', 'delete', '|b'],
	['|ab', 'C-d', '|b'],
	// Word tokens: words, punctuation runs, spaces skipped.
	['|foo.bar  baz', 'M-right', 'foo|.bar  baz'],
	['foo|.bar  baz', 'M-right', 'foo.|bar  baz'],
	['foo.bar|  baz', 'M-right', 'foo.bar  baz|'],
	['foo.bar  baz|', 'M-right', 'foo.bar  baz|'],
	['foo.bar  |baz', 'M-left', 'foo.|bar  baz'],
	['foo.|bar', 'M-left', 'foo|.bar'],
	['fo|o', 'M-left', '|foo'],
	['|  ', 'M-left', '|  '],
	['|  ', 'M-right', '  |'],
	['snake_case2 |x', 'M-left', '|snake_case2 x'],
	['|cafe\u0301 👍🏽👍🏽 x', 'M-right', 'cafe\u0301| 👍🏽👍🏽 x'],
	['cafe\u0301| 👍🏽👍🏽 x', 'M-right', 'cafe\u0301 👍🏽👍🏽| x'],
	['cafe\u0301 👍🏽👍🏽| x', 'M-left', 'cafe\u0301 |👍🏽👍🏽 x'],
	['hello wor|ld', 'M-backspace', 'hello |ld'],
	['hello |', 'M-backspace', '|'],
	['|abc', 'M-backspace', '|abc'],
	// Line and text edges.
	['ab\nc|d\nef', 'home', 'ab\n|cd\nef'],
	['ab\nc|d\nef', 'C-a', 'ab\n|cd\nef'],
	['ab\nc|d\nef', 'end', 'ab\ncd|\nef'],
	['ab\nc|d\nef', 'C-e', 'ab\ncd|\nef'],
	['|\nab', 'end', '|\nab'],
	['\n|ab', 'home', '\n|ab'],
	['|\nab', 'home', '|\nab'],
	['ab\nc|d', 's-left', '|ab\ncd'],
	['a|b\ncd', 's-right', 'ab\ncd|'],
	// Kills.
	['ab|cd\nef', 'C-k', 'ab|\nef'],
	['ab|\nef', 'C-k', 'ab|ef'],
	['ab|', 'C-k', 'ab|'],
	['ab\ncd|ef', 'C-u', 'ab\n|ef'],
	['ab\n|ef', 'C-u', 'ab|ef'],
	['|ab', 'C-u', '|ab'],
	['a |foo.bar', 'M-d', 'a |.bar'],
	['a|   foo x', 'M-d', 'a| x'],
	['ab|', 'M-d', 'ab|'],
]

describe('step', () => {
	test.each(cases)('%p + %s -> %p', (before, name, after) => {
		expect(show(press(before, name))).toBe(after)
	})
})

describe('kill and yank', () => {
	const kills: [string, string, string, string][] = [
		// before, kill key, after kill + move to end + yank
		['ab|cd', 'C-k', 'ab|', 'abcd|'],
		['ab|\ncd', 'C-k', 'ab|cd', 'abcd\n|'],
		['ab|cd', 'C-u', '|cd', 'cdab|'],
		['x\n|cd', 'C-u', 'x|cd', 'xcd\n|'],
		['|foo bar', 'M-d', '| bar', ' barfoo|'],
		['|🇫🇮 x', 'M-d', '| x', ' x🇫🇮|'],
	]
	test.each(kills)('%p + %s, then yank at the end', (before, name, killed, yanked) => {
		expect(show(press(before, name))).toBe(killed)
		expect(show(press(before, name, 's-right', 'C-y'))).toBe(yanked)
	})
	test('yank with nothing killed inserts nothing', () => {
		expect(show(press('a|b', 'C-y'))).toBe('a|b')
	})
	test('an empty kill keeps the buffer', () => {
		expect(show(press('ab|', 'C-u', 'C-k', 'C-y'))).toBe('ab|')
		expect(press('ab|', 'C-u', 'C-k').kill).toBe('ab')
	})
	test('the kill buffer survives submitting', () => {
		let st = prompt.step(press('a|b', 'C-k'), key('enter')).state
		expect(show(prompt.step(st, key('C-y')).state)).toBe('b|')
	})
	test('Alt-Backspace deletes without killing', () => {
		expect(show(press('foo|', 'M-backspace', 'C-y'))).toBe('|')
	})
})

describe('actions', () => {
	test('Ctrl-D quits only when the text is empty', () => {
		expect(prompt.step(at('|'), key('C-d')).action).toEqual({ type: 'quit' })
		expect(prompt.step(at('a|'), key('C-d')).action).toBeUndefined()
	})
	test('Enter, Shift-Enter, Alt-Enter and Escape', () => {
		expect(prompt.step(at('h|i'), key('enter')).action).toEqual({ type: 'submit', text: 'hi' })
		expect(prompt.step(at('h|i'), { key: 'enter', alt: true }).action).toEqual({ type: 'submit', text: 'hi', queue: true })
		expect(show(prompt.step(at('h|i'), { key: 'enter', shift: true }).state)).toBe('h\n|i')
		expect(prompt.step(at('h|i'), key('escape'))).toEqual({ state: at('h|i'), action: { type: 'cancel' } })
	})
})
