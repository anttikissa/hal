import { expect, test } from 'bun:test'
import { charWidth, clipVisual, expandTabs, hardWrap, visLen, wordWrap } from './strings.ts'

test('plain symbol glyphs match Ghostty single-cell width', () => {
	for (const glyph of ['▪', '▫', '▶', '◀', '✓', '×', '✗', '✔', '✔️', '✖️', '☀', '❤', '⚠', '➡', '⬅', '⬆', '⬇', '←', '→', '↑', '↓', '…']) {
		expect(visLen(glyph), glyph).toBe(1)
	}
})

test('emoji presentation and default emoji glyphs are double-cell', () => {
	for (const glyph of ['☀️', '☺️', '❤️', '✈️', '⚠️', '➡️', '⬅️', '⬆️', '⬇️', '✅', '❌', '😀', '📁', '👍']) {
		expect(visLen(glyph), glyph).toBe(2)
	}
})

test('unicode width model keeps CJK wide and combining marks narrow', () => {
	for (const glyph of ['漢', '字', 'あ', 'カ', '한']) {
		expect(visLen(glyph), glyph).toBe(2)
	}
	for (const glyph of ['é', 'é', 'â', 'ø', 'λ']) {
		expect(visLen(glyph), glyph).toBe(1)
	}
})

test('word wrap uses emoji presentation sequence width', () => {
	expect(wordWrap('ab☀️cd', 3)).toEqual(['ab', '☀️c', 'd'])
	expect(charWidth('☀'.codePointAt(0)!)).toBe(1)
})

test('tabs use four-column stops after wide glyphs', () => {
	expect(visLen('界\tX')).toBe(5)
	expect(expandTabs('界\tX')).toBe('界  X')
})

test('wrapping and clipping measure literal tabs at their displayed width', () => {
	expect(wordWrap('abc\tX', 4)).toEqual(['abc\t', 'X'])
	expect(hardWrap('abc\tX', 4)).toEqual(['abc\t', 'X'])
	expect(clipVisual('ab\tX', 4)).toBe('ab…')
})

test('word wrap contains OSC 8 hyperlinks within each visual line', () => {
	const url = 'https://example.com'
	const open = `\x1b]8;;${url}\x07`
	const close = '\x1b]8;;\x07'
	expect(wordWrap(`${open}abcdefghij${close}`, 5)).toEqual([
		`${open}abcde${close}`,
		`${open}fghij${close}`,
	])
})
