import { expect, test } from 'bun:test'
import { strings } from './strings.ts'

let { clipVisual, expandTabs, sliceVisual, visLen, wordWrap } = strings

test('plain symbol glyphs match Ghostty single-cell width', () => {
	for (let glyph of ['▪', '▫', '▶', '◀', '✓', '×', '✗', '✔', '✔️', '✖️', '☀', '❤', '⚠', '➡', '⬅', '⬆', '⬇', '←', '→', '↑', '↓', '…']) {
		expect(visLen(glyph), glyph).toBe(1)
	}
})

test('emoji presentation and default emoji glyphs are double-cell', () => {
	for (let glyph of ['☀️', '☺️', '❤️', '✈️', '⚠️', '➡️', '⬅️', '⬆️', '⬇️', '✅', '❌', '😀', '📁', '👍', '☰', '⚊']) {
		expect(visLen(glyph), glyph).toBe(2)
	}
})

test('CJK is wide, combining marks add nothing', () => {
	for (let glyph of ['漢', '字', 'あ', 'カ', '한']) expect(visLen(glyph), glyph).toBe(2)
	for (let glyph of ['é', 'e\u0301', 'â', 'ø', 'λ', 'a\u0308\u0304']) expect(visLen(glyph), glyph).toBe(1)
})

test('one grapheme cluster is one glyph: ZWJ families, flags, skin tones', () => {
	for (let glyph of ['👨‍👩‍👧', '🇫🇮', '👍🏽', '🏳️‍🌈']) expect(visLen(glyph), glyph).toBe(2)
	expect(visLen('🇫🇮🇸🇪')).toBe(4)
	// Wrapping never splits a cluster.
	expect(wordWrap('a👨‍👩‍👧b', 2)).toEqual(['a', '👨‍👩‍👧', 'b'])
})

test('escape sequences are invisible', () => {
	expect(visLen('\x1b[2mdim\x1b[22m')).toBe(3)
	expect(visLen('\x1b]8;;https://x.y\x07link\x1b]8;;\x07')).toBe(4)
	expect(visLen('\x1b[38;2;1;2;3mX')).toBe(1)
})

test('word wrap uses emoji presentation sequence width', () => {
	expect(wordWrap('ab☀️cd', 3)).toEqual(['ab', '☀️c', 'd'])
})

test('word wrap breaks at spaces, and mid-word only when it must', () => {
	expect(wordWrap('the quick brown fox', 10)).toEqual(['the quick', 'brown fox'])
	expect(wordWrap('abcdefghij kl', 4)).toEqual(['abcd', 'efgh', 'ij', 'kl'])
	expect(wordWrap('one\ntwo', 10)).toEqual(['one', 'two'])
	expect(wordWrap('漢字漢字漢', 4)).toEqual(['漢字', '漢字', '漢'])
})

test('word wrap can keep a too-long word whole on a row of its own', () => {
	expect(wordWrap('go to https://a.b/cdefgh now or else', 8, true)).toEqual(['go to', 'https://a.b/cdefgh', 'now or', 'else'])
})

test('wrapped rows never exceed the width, and keep all visible text', () => {
	let text = 'Lorem ipsum 漢字 dolor sit amet, e\u0301te 😀😀 consectetur\tadipiscing elit sed do eiusmod'
	for (let width = 1; width < 40; width++) {
		let rows = wordWrap(text, width)
		// Only a single glyph wider than the whole row may exceed it.
		for (let row of rows) if ([...new Intl.Segmenter().segment(row)].length > 1) expect(visLen(row)).toBeLessThanOrEqual(width)
		expect(rows.join('').replaceAll(' ', '')).toBe(text.replaceAll(' ', ''))
	}
})

test('tabs use four-column stops after wide glyphs', () => {
	expect(visLen('界\tX')).toBe(5)
	expect(expandTabs('界\tX')).toBe('界  X')
	expect(expandTabs('a\tb\n\tc')).toBe('a   b\n    c')
})

test('wrapping and clipping measure literal tabs at their displayed width', () => {
	expect(wordWrap('abc\tX', 4)).toEqual(['abc\t', 'X'])
	expect(clipVisual('ab\tX', 4)).toBe('ab…')
})

test('clipping keeps short text and never splits a wide glyph', () => {
	expect(clipVisual('hello', 5)).toBe('hello')
	expect(clipVisual('hello', 4)).toBe('hel…')
	expect(clipVisual('漢字漢字', 4)).toBe('漢…')
	expect(visLen(clipVisual('漢字漢字', 4))).toBeLessThanOrEqual(4)
})

test('word wrap contains OSC 8 hyperlinks within each visual line', () => {
	let url = 'https://example.com'
	let open = `\x1b]8;;${url}\x07`
	let close = '\x1b]8;;\x07'
	expect(wordWrap(`${open}abcdefghij${close}`, 5)).toEqual([`${open}abcde${close}`, `${open}fghij${close}`])
})

test('a visual slice keeps the columns asked for and the styling active there', () => {
	let red = '\x1b[31m'
	let bg = '\x1b[44m'
	let s = `ab${red}cd${bg}ef\x1b[0mgh`
	expect(sliceVisual(s, 0, 3)).toBe(`ab${red}c`)
	// A slice starting mid-style opens with the styles active there.
	expect(sliceVisual(s, 3, 5)).toBe(`${red}d${bg}e`)
	expect(visLen(sliceVisual(s, 5, 99))).toBe(3)
	expect(sliceVisual('abc', 5, 9)).toBe('')
	// A wide glyph cut by an edge becomes a space on the side kept.
	expect(sliceVisual('a漢b', 0, 2)).toBe('a ')
	expect(sliceVisual('a漢b', 2, 4)).toBe(' b')
	for (let [from, to] of [[0, 1], [1, 3], [2, 5], [0, 9]] as const) {
		let cut = sliceVisual('漢字e\u0301👨‍👩‍👧x', from, to)
		expect(visLen(cut)).toBe(Math.min(to, 8) - from)
	}
})
