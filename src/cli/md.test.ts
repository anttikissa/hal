import { test, expect, describe } from 'bun:test'
import { md } from './md.ts'
import {
	visLen,
	hardWrap,
	resolveMarkers,
	M_BOLD,
	M_BOLD_OFF,
	M_ITALIC,
	M_ITALIC_OFF,
	M_DIM,
	M_DIM_OFF,
} from '../utils/strings.ts'

// mdInline outputs PUA marker chars, not raw ANSI.
// resolveMarkers() converts them to ANSI later.
const B = M_BOLD,
	B_OFF = M_BOLD_OFF
const I = M_ITALIC,
	I_OFF = M_ITALIC_OFF
const DIM = M_DIM,
	DIM_OFF = M_DIM_OFF

/** Strip ANSI escapes AND marker chars for plain-text assertions. */
function strip(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, '').replace(/[\uE000-\uE005]/g, '')
}

// ── mdInline ─────────────────────────────────────────────────────────────────

test('mdInline: bold', () => {
	expect(md.mdInline('hello **world**')).toBe(`hello ${B}world${B_OFF}`)
})

test('mdInline: italic', () => {
	expect(md.mdInline('hello *world*')).toBe(`hello ${I}world${I_OFF}`)
})

test('mdInline: inline code', () => {
	expect(md.mdInline('run `npm install`')).toBe(`run ${DIM}npm install${DIM_OFF}`)
})

test('mdInline: bold code — bold wins, no dim', () => {
	expect(md.mdInline('see **`file.ts`**')).toBe(`see ${B}file.ts${B_OFF}`)
})

test('mdInline: header', () => {
	const r = md.mdInline('## Hello **world**')
	expect(r).toBe(`${B}Hello ${B}world${B_OFF}${B_OFF}`)
})

test('mdInline: no false italic on **bold**', () => {
	const r = md.mdInline('**bold**')
	expect(r).toBe(`${B}bold${B_OFF}`)
	expect(r).not.toContain(I)
})

test('mdInline: star inside backtick code is not italic', () => {
	const r = md.mdInline('matching `state/sessions/*/session.ason` and `*` only')
	expect(r).not.toContain(I)
	expect(r).toContain(`${DIM}state/sessions/*/session.ason${DIM_OFF}`)
	expect(r).toContain(`${DIM}*${DIM_OFF}`)
})


test('mdInline: escaped stars stay literal', () => {
	const r = md.mdInline('a\\*\\*\\*@g\\*\\*\\*\\*.com')
	expect(strip(r)).toBe('a***@g****.com')
	expect(r).not.toContain(I)
})

test('mdInline: plain text unchanged', () => {
	expect(md.mdInline('just text')).toBe('just text')
})

test('mdInline: multiple bold spans', () => {
	expect(md.mdInline('**a** and **b**')).toBe(`${B}a${B_OFF} and ${B}b${B_OFF}`)
})

// ── mdSpans ──────────────────────────────────────────────────────────────────

test('mdSpans: text only', () => {
	expect(md.mdSpans('hello\nworld')).toEqual([{ type: 'text', lines: ['hello', 'world'] }])
})

test('mdSpans: code fence', () => {
	const spans = md.mdSpans('before\n```ts\nconst x = 1\n```\nafter')
	expect(spans).toEqual([
		{ type: 'text', lines: ['before'] },
		{ type: 'code', lang: 'ts', lines: ['const x = 1'] },
		{ type: 'text', lines: ['after'] },
	])
})

test('mdSpans: code fence with no lang', () => {
	const spans = md.mdSpans('```\ncode\n```')
	expect(spans).toEqual([{ type: 'code', lang: '', lines: ['code'] }])
})

test('mdSpans: unclosed code fence', () => {
	const spans = md.mdSpans('```\ncode here')
	expect(spans).toEqual([{ type: 'code', lang: '', lines: ['code here'] }])
})

test('mdSpans: table', () => {
	const spans = md.mdSpans('text\n| a | b |\n| c | d |\nmore')
	expect(spans.length).toBe(3)
	expect(spans[0]).toEqual({ type: 'text', lines: ['text'] })
	expect(spans[1]).toEqual({ type: 'table', lines: ['| a | b |', '| c | d |'] })
	expect(spans[2]).toEqual({ type: 'text', lines: ['more'] })
})

test('mdSpans: multiple code blocks', () => {
	const spans = md.mdSpans('```\na\n```\nmiddle\n```\nb\n```')
	expect(spans).toEqual([
		{ type: 'code', lang: '', lines: ['a'] },
		{ type: 'text', lines: ['middle'] },
		{ type: 'code', lang: '', lines: ['b'] },
	])
})

// ── mdTable ──────────────────────────────────────────────────────────────────

test('mdTable: box-drawing with aligned columns', () => {
	const lines = ['| name | age |', '|------|-----|', '| Alice | 30 |', '| Bob | 7 |']
	const result = md.mdTable(lines, 80)
	expect(result).toEqual([
		'┌───────┬─────┐',
		'│ name  │ age │',
		'├───────┼─────┤',
		'│ Alice │ 30  │',
		'├───────┼─────┤',
		'│ Bob   │ 7   │',
		'└───────┴─────┘',
	])
})

test('mdTable: bold cells do not inflate column width', () => {
	const lines = ['| **Commit** | **Fix** |', '|---|---|', '| abc | def |']
	const result = md.mdTable(lines, 80)
	// **Commit** has 6 visible chars, not 10. Column should be 6 wide.
	expect(result.map(strip)).toEqual([
		'┌────────┬─────┐',
		'│ Commit │ Fix │',
		'├────────┼─────┤',
		'│ abc    │ def │',
		'└────────┴─────┘',
	])
	// Verify ANSI bold is present in header (markers already resolved inside mdTable)
	expect(result[1]).toContain('\x1b[1m')
})

test('mdTable: inline code cells measured correctly', () => {
	const lines = ['| Command | Description |', '|---|---|', '| `ls -la` | list files |']
	const result = md.mdTable(lines, 80)
	// "Command" (7) vs "ls -la" (6) → header wins at 7
	expect(result.map(strip)).toEqual([
		'┌─────────┬─────────────┐',
		'│ Command │ Description │',
		'├─────────┼─────────────┤',
		'│ ls -la  │ list files  │',
		'└─────────┴─────────────┘',
	])
})

test('mdTable: emoji cells measured with visLen', () => {
	const lines = ['| Status | Item |', '|---|---|', '| ✅ | done |', '| ❌ | todo |']
	const result = md.mdTable(lines, 80)
	// ✅ is 2 columns wide. "Status" (6) wins over ✅ (2).
	expect(result.map(strip)).toEqual([
		'┌────────┬──────┐',
		'│ Status │ Item │',
		'├────────┼──────┤',
		'│ ✅     │ done │',
		'├────────┼──────┤',
		'│ ❌     │ todo │',
		'└────────┴──────┘',
	])
})

test('mdTable: all lines fit within given width', () => {
	const lines = [
		'| Area | Previous | Us now | Status |',
		'|---|---|---|---|',
		'| CLI/UI (render, prompt, keys, tabs, diff, blocks, colors) | 3,520 | 1,132 | ~32% done |',
		'| Runtime/Agent (agent loop, commands, context) | 2,089 | 79 | ~4% done |',
	]
	const width = 60
	const result = md.mdTable(lines, width)
	for (const line of result) {
		expect(visLen(line)).toBeLessThanOrEqual(width)
	}
})

test('mdTable: wide cells wrap within column', () => {
	const lines = ['| Name | Description |', '|---|---|', '| foo | This is a very long description that should wrap |']
	const result = md.mdTable(lines, 40)
	const plain = result.map(strip)
	// Every line has proper borders
	for (const line of plain) {
		if (line.includes('│')) {
			// Data/header rows: exactly 3 │ characters (left, middle, right)
			expect(line.split('│').length - 1).toBe(3)
		}
	}
	// No line exceeds width
	for (const line of result) {
		expect(visLen(line)).toBeLessThanOrEqual(40)
	}
	// Content is preserved across wrapped lines
	const allText = plain.join(' ')
	expect(allText).toContain('very long')
	expect(allText).toContain('should wrap')
})

test('mdTable: row dividers between data rows', () => {
	const lines = ['| a | b |', '|---|---|', '| x | y |', '| p | q |']
	const result = md.mdTable(lines, 80)
	const plain = result.map(strip)
	// Should have a ┼ divider between the two data rows
	const dividers = plain.filter((l) => l.includes('┼'))
	expect(dividers.length).toBe(2) // header-sep + between-rows
})

test('mdTable: skips separator row', () => {
	const lines = ['| a | b |', '| --- | --- |', '| x | y |']
	const result = md.mdTable(lines, 80)
	const plain = result.map(strip)
	// No raw "---" in output
	expect(plain.join('\n')).not.toContain('---')
})

test('mdTable: empty after filtering', () => {
	expect(md.mdTable(['| --- | --- |'], 80)).toEqual([])
})


test('mdTable: explicit <br> creates multiple lines inside a cell', () => {
	const lines = ['| name | usage |', '|---|---|', '| alpha | [████▌░░]<br>68% used |']
	const result = md.mdTable(lines, 80)
	const plain = result.map(strip)

	expect(plain).toContain('│ alpha │ [████▌░░] │')
	expect(plain).toContain('│       │ 68% used  │')
})

// ── resolveMarkers ───────────────────────────────────────────────────────────

test('resolveMarkers: single line, no wrapping', () => {
	const lines = [`hello ${M_BOLD}world${M_BOLD_OFF}`]
	const result = resolveMarkers(lines)
	expect(result).toEqual(['hello \x1b[1mworld\x1b[22m'])
})

test('resolveMarkers: style split across lines — re-opens and closes', () => {
	// Simulates what happens when wordWrap splits mid-bold
	const lines = [`${M_DIM}some dim text`, `continues here${M_DIM_OFF}`]
	const result = resolveMarkers(lines)
	// Line 1: open dim, close at EOL
	expect(result[0]).toBe('\x1b[2msome dim text\x1b[22m')
	// Line 2: re-open dim at BOL, close at marker
	expect(result[1]).toBe('\x1b[2mcontinues here\x1b[22m')
})

test('resolveMarkers: no markers — passes through unchanged', () => {
	const lines = ['plain text', '\x1b[33malready ansi\x1b[0m']
	expect(resolveMarkers(lines)).toEqual(lines)
})

describe('hardWrap', () => {
	test('short line unchanged', () => {
		expect(hardWrap('hello', 10)).toEqual(['hello'])
	})

	test('breaks at exact column boundary', () => {
		expect(hardWrap('abcdefghij', 5)).toEqual(['abcde', 'fghij'])
	})

	test('handles remainder', () => {
		expect(hardWrap('abcdefgh', 5)).toEqual(['abcde', 'fgh'])
	})

	test('preserves ANSI escapes', () => {
		const s = '\x1b[31mred text here\x1b[0m'
		const lines = hardWrap(s, 8)
		// "red text" = 8 cols, " here" = 5 cols
		expect(lines.length).toBe(2)
		// ANSI escapes don't count toward column width
		expect(visLen(lines[0]!)).toBe(8)
		expect(visLen(lines[1]!)).toBe(5)
	})
})
