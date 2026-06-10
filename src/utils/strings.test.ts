import { expect, test } from 'bun:test'
import { charWidth, visLen, wordWrap } from './strings.ts'

test('plain symbol glyphs match Ghostty single-cell width', () => {
	for (const glyph of ['▪', '▫', '▶', '◀', '✓', '×', '✗', '✔', '✔️', '✖️', '☀', '❤', '⚠', '➡', '⬅', '⬆', '⬇', '←', '→', '↑', '↓', '…']) {
		expect(visLen(glyph), glyph).toBe(1)
	}
})

test('emoji presentation and default emoji glyphs are double-cell', () => {
	for (const glyph of ['☀️', '❤️', '✈️', '⚠️', '➡️', '⬅️', '⬆️', '⬇️', '✅', '❌', '😀', '📁', '👍']) {
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
