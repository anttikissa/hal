import { test, expect } from 'bun:test'
import { mdSpans, mdInline, mdTable, visLen, wordWrap, charWidth } from './md.ts'

// ── charWidth ──

test('charWidth: ASCII', () => {
	expect(charWidth(0x41)).toBe(1) // A
	expect(charWidth(0x20)).toBe(1) // space
})

test('charWidth: wide emoji', () => {
	expect(charWidth(0x2705)).toBe(2) // ✅
	expect(charWidth(0x274C)).toBe(2) // ❌
	expect(charWidth(0x2764)).toBe(2) // ❤
})

test('charWidth: CJK', () => {
	expect(charWidth(0x4E2D)).toBe(2) // 中
	expect(charWidth(0x3042)).toBe(2) // あ
})

test('charWidth: zero-width', () => {
	expect(charWidth(0x0300)).toBe(0) // combining grave
	expect(charWidth(0x200D)).toBe(0) // ZWJ
})

// ── visLen ──

test('visLen: plain string', () => {
	expect(visLen('hello')).toBe(5)
})

test('visLen: with ANSI escapes', () => {
	expect(visLen('\x1b[1mbold\x1b[22m')).toBe(4)
	expect(visLen('\x1b[2m\x1b[3mhi\x1b[23m\x1b[22m')).toBe(2)
})

test('visLen: wide emoji counts as 2', () => {
	expect(visLen('- ✅ Hello')).toBe(10) // ✅ takes 2 columns
	expect(visLen('a✅b')).toBe(4)
})

test('visLen: non-BMP emoji (surrogate pair)', () => {
	expect(visLen('🔴')).toBe(2)
})

test('visLen: OSC 8 hyperlinks have zero width', () => {
	const link = '\x1b]8;;file:///tmp/test.ason\x07visible\x1b]8;;\x07'
	expect(visLen(link)).toBe(7) // only "visible" counts
})

// ── mdInline ──

test('mdInline: bold', () => {
	expect(mdInline('hello **world**')).toBe('hello \x1b[1mworld\x1b[22m')
})

test('mdInline: italic', () => {
	expect(mdInline('hello *world*')).toBe('hello \x1b[3mworld\x1b[23m')
})

test('mdInline: inline code', () => {
	expect(mdInline('run `npm install`')).toBe('run \x1b[2mnpm install\x1b[22m')
})

test('mdInline: bold code strips both markers', () => {
	expect(mdInline('see **`file.ts`**')).toBe('see \x1b[1mfile.ts\x1b[22m')
})

test('mdInline: header', () => {
	expect(mdInline('## Hello **world**')).toBe('\x1b[1mHello \x1b[1mworld\x1b[22m\x1b[22m')
})

test('mdInline: no false italic on **bold**', () => {
	const r = mdInline('**bold**')
	expect(r).toBe('\x1b[1mbold\x1b[22m')
	expect(r).not.toContain('\x1b[3m')
})

test('mdInline: star inside backtick code is not italic', () => {
	const r = mdInline('matching `state/sessions/*/session.ason` and the `*` only')
	expect(r).not.toContain('\x1b[3m') // no italic
	// both code spans should be present
	expect(r).toContain('\x1b[2mstate/sessions/*/session.ason\x1b[22m')
	expect(r).toContain('\x1b[2m*\x1b[22m')
})

// ── mdSpans ──

test('mdSpans: text only', () => {
	const spans = mdSpans('hello\nworld')
	expect(spans).toEqual([{ type: 'text', lines: ['hello', 'world'] }])
})

test('mdSpans: code fence', () => {
	const spans = mdSpans('before\n```ts\nconst x = 1\n```\nafter')
	expect(spans).toEqual([
		{ type: 'text', lines: ['before'] },
		{ type: 'code', lines: ['const x = 1'] },
		{ type: 'text', lines: ['after'] },
	])
})

test('mdSpans: unclosed code fence', () => {
	const spans = mdSpans('```\ncode here')
	expect(spans).toEqual([{ type: 'code', lines: ['code here'] }])
})

test('mdSpans: table', () => {
	const spans = mdSpans('text\n| a | b |\n| c | d |\nmore')
	expect(spans.length).toBe(3)
	expect(spans[0]).toEqual({ type: 'text', lines: ['text'] })
	expect(spans[1]).toEqual({ type: 'table', lines: ['| a | b |', '| c | d |'] })
	expect(spans[2]).toEqual({ type: 'text', lines: ['more'] })
})

// ── mdTable ──

test('mdTable: aligns columns', () => {
	const lines = ['| name | age |', '|------|-----|', '| Alice | 30 |', '| Bob | 7 |']
	const result = mdTable(lines)
	expect(result).toEqual([
		'  name   age',
		'  Alice  30 ',
		'  Bob    7  ',
	])
})

test('mdTable: skips separator row', () => {
	const lines = ['| a | b |', '| --- | --- |', '| x | y |']
	const result = mdTable(lines)
	expect(result.length).toBe(2)
})

// ── wordWrap ──

test('wordWrap: plain short line unchanged', () => {
	expect(wordWrap('hello world', 80)).toEqual(['hello world'])
})

test('wordWrap: breaks at word boundary', () => {
	expect(wordWrap('hello world foo', 11)).toEqual(['hello world', 'foo'])
})

test('wordWrap: handles ANSI escapes', () => {
	const bold = '\x1b[1mvery long bold text here\x1b[22m'
	const lines = wordWrap(bold, 15)
	expect(lines.length).toBe(2)
	// visual content of first line should be ≤ 15
	expect(visLen(lines[0])).toBeLessThanOrEqual(15)
})

test('wordWrap: preserves existing newlines', () => {
	expect(wordWrap('a\nb\nc', 80)).toEqual(['a', 'b', 'c'])
})
