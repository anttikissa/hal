import { describe, test, expect } from 'bun:test'
import type { Key } from './forms.ts'
import { prompt, type PromptState } from './prompt.ts'
import { promptLayout } from './prompt-layout.ts'
import { settings } from './settings.ts'
import { strings } from './strings.ts'

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

// Steps with the terminal's content width.
function pressAt(width: number, marked: string, ...names: string[]): PromptState {
	let st = at(marked)
	for (let n of names) st = prompt.step(st, key(n), width).state
	return st
}

describe('layout', () => {
	// Rows drawn from the ranges are exactly what wordWrap draws.
	test.each([
		['hello world, this is a prompt', 8],
		['a  b   c    d', 3],
		['\tif x\n\t\tprintf("hi")\n\n漢字漢字漢字 ok', 5],
		['abcd ', 4],
		['x'.repeat(20), 6],
	])('rows match the wrap helper: %j at %d', (text, width) => {
		let rows = promptLayout.rows(text, width)
		let wrapped = text.split('\n').flatMap((l) => strings.wordWrap(l, width))
		expect(rows.map((r) => text.slice(r.start, r.end)).filter((r) => r)).toEqual(wrapped.filter((r) => r))
		for (let r of rows) expect(strings.visLen(text.slice(r.start, r.end))).toBeLessThanOrEqual(width)
	})
	test('the cursor stays in the right padding when text exactly fills a row', () => {
		let rows = promptLayout.rows('abcd', 4)
		expect(rows.length).toBe(1)
		expect(promptLayout.position('abcd', rows, 4)).toEqual({ row: 0, col: 4 })
	})
	test('tabs wrap at their displayed width', () => {
		let rows = promptLayout.rows('abc\tX', 4)
		expect(rows.map((r) => strings.expandTabs('abc\tX'.slice(r.start, r.end)))).toEqual(['abc ', 'X'])
	})
	test('a space typed past a full row puts the cursor on a new row', () => {
		let rows = promptLayout.rows('abcd ', 4)
		expect(promptLayout.position('abcd ', rows, 5)).toEqual({ row: 1, col: 0 })
	})
})

describe('vertical movement', () => {
	test('up and down move between wrapped rows keeping the column', () => {
		// Rows: "abcdef" "ghijkl" "mn".
		expect(show(pressAt(6, 'abcdefghij|klmn', 'up'))).toBe('abcd|efghijklmn')
		expect(show(pressAt(6, 'abcdefghij|klmn', 'down'))).toBe('abcdefghijklmn|')
		expect(show(pressAt(6, 'abc|defghijklmn', 'down', 'down'))).toBe('abcdefghijklmn|')
	})
	test('the goal column survives a short row in between', () => {
		expect(show(pressAt(80, 'long line|\nab\nlong line', 'down', 'down'))).toBe('long line\nab\nlong line|')
		expect(show(pressAt(80, 'long line|\nab\nlong line', 'down'))).toBe('long line\nab|\nlong line')
	})
	test('any other key forgets the goal column', () => {
		expect(show(pressAt(80, 'long line|\nab\nlong line', 'down', 'left', 'down'))).toBe('long line\nab\nl|ong line')
	})
	test('a wrapped row ends before the glyph that starts the next', () => {
		expect(show(pressAt(4, 'abcdefgh|', 'up'))).toBe('abc|defgh')
	})
	test('up keeps the visual column across tab-indented lines', () => {
		expect(show(pressAt(80, '\tif\n|\t\tprintf', 'up'))).toBe('|\tif\n\t\tprintf')
		expect(show(pressAt(80, '\t\tprintf|\n\tif', 'down'))).toBe('\t\tprintf\n\tif|')
	})
	test('a column inside a tab or wide glyph snaps to the nearer edge', () => {
		expect(show(pressAt(80, '\tX\nabc|', 'up'))).toBe('\t|X\nabc')
		expect(show(pressAt(80, '\tX\na|bc', 'up'))).toBe('|\tX\nabc')
		expect(show(pressAt(80, '漢字\nabc|', 'up'))).toBe('漢字|\nabc')
		expect(show(pressAt(80, '漢字\nab|c', 'up'))).toBe('漢|字\nabc')
	})
	test('past the top or bottom row, up and down go to the edges', () => {
		expect(show(pressAt(80, 'ab|c\ndef', 'up'))).toBe('|abc\ndef')
		expect(show(pressAt(80, 'abc\nd|ef', 'down'))).toBe('abc\ndef|')
	})
	test('Alt-Up and Alt-Down go to the start and end of the text', () => {
		expect(show(pressAt(80, 'abc\nd|ef\nghi', 'M-up'))).toBe('|abc\ndef\nghi')
		expect(show(pressAt(80, 'abc\nd|ef\nghi', 'M-down'))).toBe('abc\ndef\nghi|')
	})
	test('Home and End still act on the logical line', () => {
		expect(show(pressAt(4, 'abcdef|gh', 'home'))).toBe('|abcdefgh')
		expect(show(pressAt(4, 'ab|cdefgh', 'end'))).toBe('abcdefgh|')
	})
})

describe('box height', () => {
	let text = 'one\ntwo|'
	test('grows a row at a time and shrinks back to automatic', () => {
		expect(pressAt(80, text, 'C-=').rows).toBe(3)
		expect(pressAt(80, text, 'C-up', 'C-up').rows).toBe(4)
		expect(pressAt(80, text, 'C-=', 'C-=', 'C--').rows).toBe(3)
		expect(pressAt(80, text, 'C-=', 'C-down').rows).toBeUndefined()
	})
	test('never shrinks below its automatic height', () => {
		expect(pressAt(80, text, 'C--', 'C-down').rows).toBeUndefined()
		expect(prompt.autoRows(at(text), 80)).toBe(2)
		let long = at('x\n'.repeat(30))
		expect(prompt.autoRows(long, 80)).toBe(settings.promptRows())
	})
	test('sending resets it', () => {
		let st = pressAt(80, text, 'C-=')
		expect(prompt.step(st, key('enter'), 80).state.rows).toBeUndefined()
	})
})

describe('viewport', () => {
	test('moves only when the cursor row leaves it, keeping a row of context', () => {
		expect(promptLayout.viewport(4, 3, 8, 5)).toEqual({ top: 4, height: 3, above: 4, below: 1 })
		expect(promptLayout.viewport(4, 3, 8, 7)).toEqual({ top: 5, height: 3, above: 5, below: 0 })
		expect(promptLayout.viewport(4, 3, 8, 2)).toEqual({ top: 1, height: 3, above: 1, below: 4 })
		expect(promptLayout.viewport(0, 10, 3, 2)).toEqual({ top: 0, height: 10, above: 0, below: 0 })
	})
})
