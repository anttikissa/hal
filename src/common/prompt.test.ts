import { describe, test, expect } from 'bun:test'
import type { Key } from './forms.ts'
import { prompt, type PromptState } from './prompt.ts'
import { promptLayout } from './prompt-layout.ts'
import { settings } from './settings.ts'
import { strings } from './strings.ts'

// '|' marks the cursor and '^' the selection's anchor, in both the
// input and the expected text.
function at(marked: string, kill?: string): PromptState {
	let text = marked.replace(/[|^]/g, '')
	let cursor = marked.replace('^', '').indexOf('|')
	let anchor = marked.includes('^') ? marked.replace('|', '').indexOf('^') : undefined
	let st: PromptState = anchor === undefined ? { text, cursor } : { text, cursor, anchor }
	return kill === undefined ? st : { ...st, kill }
}

function show(st: PromptState): string {
	let marks: [number, string][] = [[st.cursor, '|']]
	if (st.anchor !== undefined && st.anchor !== st.cursor) marks.push([st.anchor, '^'])
	let out = st.text
	for (let [at, mark] of marks.sort((a, b) => b[0] - a[0])) out = out.slice(0, at) + mark + out.slice(at)
	return out
}

// Key names with emacs-style prefixes: C- ctrl, M- alt, s- cmd, S- shift.
// A lone character without ctrl, alt or cmd is typed.
function key(name: string): Key {
	let k: Key = { key: name }
	for (;;) {
		let m = /^([CMsS])-(.+)$/.exec(k.key)
		if (!m) break
		k = { ...k, key: m[2]!, ...({ C: { ctrl: true }, M: { alt: true }, s: { cmd: true }, S: { shift: true } } as const)[m[1] as 'C'] }
	}
	return [...k.key].length === 1 && !k.ctrl && !k.alt && !k.cmd ? { ...k, text: k.key } : k
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
	// Deletes go by whitespace words, moves by tokens.
	['cat src/host/tools.ts|', 'M-backspace', 'cat |'],
	['cat src/host/tools.ts|', 'M-left', 'cat src/host/tools.|ts'],
	['a  foo.ba|r x', 'M-backspace', 'a  |r x'],
	['a b\n  |x', 'M-backspace', 'a |x'],
	['a cafe\u0301👍🏽|', 'M-backspace', 'a |'],
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
	['a |foo.bar', 'M-d', 'a |'],
	['|cat src/host x', 'M-right', 'cat| src/host x'],
	['cat| src/host x', 'M-d', 'cat| x'],
	['a|\n foo x', 'M-d', 'a| x'],
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
		['|a/b.c d', 'M-d', '| d', ' da/b.c|'],
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
		expect(prompt.step(at('h|i'), key('enter')).action).toEqual({ type: 'submit', text: 'hi', delivery: 'interject' })
		expect(prompt.step(at('h|i'), { key: 'enter', alt: true }).action).toEqual({ type: 'submit', text: 'hi', delivery: 'queue' })
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

describe('selection', () => {
	const moves: [string, string[], string][] = [
		// Shift with any movement extends from the anchor.
		['a|bc', ['S-right', 'S-right'], 'a^bc|'],
		['ab|c', ['S-left', 'S-left'], '|ab^c'],
		['a^b|c', ['S-left'], 'a|bc'],
		['foo |bar baz', ['S-M-right'], 'foo ^bar| baz'],
		['foo bar| baz', ['S-M-left'], 'foo |bar^ baz'],
		['ab\nc|d', ['S-home'], 'ab\n|c^d'],
		['ab\nc|d', ['S-C-a'], 'ab\n|c^d'],
		['a|b\ncd', ['S-end'], 'a^b|\ncd'],
		['a|b\ncd', ['S-s-right'], 'a^b\ncd|'],
		['ab\nc|d', ['S-s-left'], '|ab\nc^d'],
		['abc\nd|ef', ['S-up'], 'a|bc\nd^ef'],
		['a|bc\ndef', ['S-down', 'S-down'], 'a^bc\ndef|'],
		['abc\nd|ef\nghi', ['S-M-up'], '|abc\nd^ef\nghi'],
		['a|b', ['s-a'], '^ab|'],
		// Plain Left/Right collapse to the start or end; other moves drop it.
		['^ab|c', ['left'], '|abc'],
		['|ab^c', ['right'], 'ab|c'],
		['^ab|c', ['end'], 'abc|'],
		['a^b|c', ['up'], '|abc'],
		// Edits replace or delete the selection.
		['^ab|c', ['x'], 'x|c'],
		['a|bc^', ['backspace'], 'a|'],
		['a|bc^', ['delete'], 'a|'],
		['a|bc^', ['C-d'], 'a|'],
		['^ab|c', ['S-enter'], '\n|c'],
	]
	test.each(moves)('%p + %p -> %p', (before, names, after) => {
		expect(show(press(before, ...names))).toBe(after)
	})
	test('Alt-D deletes it without killing', () => {
		let st = { ...at('x^ab|c d'), kill: 'K' }
		let out = prompt.step(st, key('M-d')).state
		expect(show(out)).toBe('x|c d')
		expect(out.kill).toBe('K')
	})
	test('Ctrl-K and Ctrl-U ignore it, kill from the cursor and drop it', () => {
		expect(show(press('x^ab|c\nd', 'C-k'))).toBe('xab|\nd')
		expect(show(press('x^ab|c\nd', 'C-u'))).toBe('|c\nd')
		expect(press('x^ab|c', 'C-k').anchor).toBeUndefined()
	})
	test('paste and Ctrl-Y replace it', () => {
		expect(show(prompt.step(at('x^ab|c'), { key: 'paste', text: 'P' }).state)).toBe('xP|c')
		let st = { ...at('x^ab|c'), kill: 'K' }
		expect(show(prompt.step(st, key('C-y')).state)).toBe('xK|c')
	})
	test('keys that are not edits or moves keep it', () => {
		expect(show(press('^ab|c', 'escape'))).toBe('^ab|c')
		expect(show(pressAt(80, '^ab|c', 'C-='))).toBe('^ab|c')
	})
})

describe('undo', () => {
	const type = (st: PromptState, s: string) => [...s].reduce((st, c) => prompt.step(st, key(c)).state, st)
	test('consecutive typed characters are one step; any other key ends it', () => {
		let st = type(at('|'), 'ab')
		st = prompt.step(st, key('left')).state
		st = type(st, 'xy')
		expect(show(st)).toBe('axy|b')
		st = prompt.step(st, key('C-/')).state
		expect(show(st)).toBe('a|b')
		st = prompt.step(st, key('C-/')).state
		expect(show(st)).toBe('|')
	})
	test('each other edit is a step of its own', () => {
		expect(show(press('abc|', 'backspace', 'backspace', 'C-/'))).toBe('ab|')
		expect(show(press('abc|', 'backspace', 'backspace', 'C-/', 'C-/'))).toBe('abc|')
		expect(show(press('ab|', 'tab', 'tab', 'C-/'))).toBe('ab\t|')
	})
	test('a step restores text, cursor and selection', () => {
		expect(show(press('x^ab|c', 'y', 'C-/'))).toBe('x^ab|c')
		expect(show(press('x^ab|c', 'y', 'C-/', 'S-C-/'))).toBe('xy|c')
	})
	test('Cmd-Z and Cmd-U undo too, with Shift they redo', () => {
		for (let k of ['s-z', 's-u']) {
			expect(show(press('ab|', 'backspace', k))).toBe('ab|')
			expect(show(press('ab|', 'backspace', k, `S-${k}`))).toBe('a|')
		}
	})
	test('a new edit forgets what could be redone', () => {
		expect(show(press('ab|', 'backspace', 'C-/', 'x', 'S-C-/'))).toBe('abx|')
	})
	test('nothing to undo or redo changes nothing', () => {
		expect(show(press('a|b', 'C-/', 'S-C-/'))).toBe('a|b')
	})
	test('moves alone are not steps', () => {
		expect(show(press('ab|', 'backspace', 'left', 'S-right', 'C-/'))).toBe('ab|')
	})
	test('at most 200 steps are kept', () => {
		let st = at('|')
		for (let i = 0; i < 250; i++) st = prompt.step(st, { key: 'paste', text: 'x' }).state
		for (let i = 0; i < 300; i++) st = prompt.step(st, key('C-/')).state
		expect(st.text).toBe('x'.repeat(50))
	})
	test('sending clears the stacks', () => {
		let st = prompt.step(press('ab|', 'backspace'), key('enter')).state
		expect(show(prompt.step(st, key('C-/')).state)).toBe('|')
		expect(show(prompt.step(st, key('S-C-/')).state)).toBe('|')
	})
})

describe('tab', () => {
	const cases: [string, string, string][] = [
		['ab|', 'tab', 'ab\t|'],
		['a|b', 'tab', 'a\t|b'],
		// Indents every line the selection touches; the selection takes in
		// the first line's new tab.
		['o^ne\ntw|o\nthree', 'tab', '^\tone\n\ttw|o\nthree'],
		['o|ne\ntw^o\nthree', 'tab', '|\tone\n\ttw^o\nthree'],
		['o^n|e', 'tab', '^\ton|e'],
		// A line touched only at its first column by the selection end is
		// left out, unless the cursor rests there.
		['o|ne\n^two', 'tab', '|\tone\n^two'],
		['o^ne\n|two', 'tab', '^\tone\n\t|two'],
		// Shift-Tab removes one level from the selected or current line.
		['one\n  tw|o', 'S-tab', 'one\ntw|o'],
		['\t\tx|', 'S-tab', '\tx|'],
		['        x|', 'S-tab', '    x|'],
		['   \tx|', 'S-tab', 'x|'],
		['|x', 'S-tab', '|x'],
		['|\tone\n  \ttwo\n   three\nfour^', 'S-tab', '|one\ntwo\nthree\nfour^'],
	]
	test.each(cases)('%p + %s -> %p', (before, name, after) => {
		expect(show(press(before, name))).toBe(after)
	})
	test('an indent is one step', () => {
		expect(show(press('o^ne\ntw|o\nthree', 'tab', 'C-/'))).toBe('o^ne\ntw|o\nthree')
		let text = '|\tone\n  \ttwo\n   three\nfour^'
		expect(show(press(text, 'S-tab', 'C-/'))).toBe(text)
	})
})

describe('paste and cut', () => {
	const paste = (st: PromptState, text: string) => prompt.step(st, { key: 'paste', text }).state

	test('pasted text becomes LF lines without control characters, keeping tabs', () => {
		expect(show(paste(at('x|'), 'a\r\nb\rc\x1b[31m\x07\td\x7f\u009be'))).toBe('xa\nb\nc[31m\tde|')
	})

	test('a paste replaces the selection and is one undo step', () => {
		let st = paste(at('ab^cd|e'), 'XY')
		expect(show(st)).toBe('abXY|e')
		expect(show(prompt.step(st, key('C-/')).state)).toBe('ab^cd|e')
	})

	test('a paste of nothing but control characters changes nothing', () => {
		expect(show(paste(at('a^b|'), '\x1b\x00'))).toBe('a^b|')
	})

	test('Cmd-X removes the selection as one undo step; Cmd-C keeps it', () => {
		let st = press('ab^cd|e', 's-x')
		expect(show(st)).toBe('ab|e')
		expect(show(prompt.step(st, key('C-/')).state)).toBe('ab^cd|e')
		expect(show(press('ab^cd|e', 's-c'))).toBe('ab^cd|e')
		expect(show(press('ab|cde', 's-x'))).toBe('ab|cde')
	})
})
