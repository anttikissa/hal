import { afterEach, describe, expect, test } from 'bun:test'
import { colors } from '../common/colors.ts'
import { strings } from '../common/strings.ts'
import type { Transcript } from '../common/transcript.ts'
import { frame, type View } from './frame.ts'
import { markdownView } from './markdown-view.ts'

const REPLY = [
	'# Plan',
	'',
	'The **fix** is *small*: see [the doc](https://example.com/a) and `code`.',
	'',
	'| Name | What it does |',
	'|---|---|',
	'| parser | turns **text** into blocks |',
	'| renderer | draws the blocks with a much longer description in its cell |',
	'',
	'```ts',
	'let x = 2**3',
	'```',
	'Done &amp; dusted.',
].join('\n')

const visible = (s: string) => s.replace(/\x1b\]8;;[^\x07]*\x07/g, '').replace(/\x1b\[[\d;]*m/g, '')

describe('terminal markdown', () => {
	test('streamed a character at a time, a reply never loses a row', () => {
		for (let width of [24, 40, 80]) {
			let prev = 0
			for (let i = 1; i <= REPLY.length; i++) {
				let rows = markdownView.lines(REPLY.slice(0, i), width, true)
				expect(rows.length).toBeGreaterThanOrEqual(prev)
				prev = rows.length
			}
			expect(markdownView.lines(REPLY, width).length).toBeGreaterThanOrEqual(prev)
		}
	})

	test('markers are hidden, code kept as written, every row fits', () => {
		let rows = markdownView.lines(REPLY, 24)
		let text = rows.map(visible)
		expect(text[0]).toBe('Plan')
		expect(text.join('\n')).not.toMatch(/\*\*text|\[the doc\]|https:/)
		expect(text).toContain('let x = 2**3')
		expect(text).toContain('Done & dusted.')
		for (let r of rows) expect(strings.visLen(r)).toBeLessThanOrEqual(24)
		// The link's address is its hidden target.
		expect(rows.join('')).toContain('\x1b]8;;https://example.com/a\x07')
		// A table too wide for even one letter a column is clipped, not wider.
		for (let r of markdownView.lines('| a | b | c | d |\n|-|-|-|-|\n| 1 | 2 | 3 | 4 |', 10)) expect(strings.visLen(r)).toBeLessThanOrEqual(10)
	})

	test('a table keeps every word whole while columns can wrap', () => {
		let rows = markdownView.lines('| key | description |\n|---|---|\n| identifier_name | one two three four five six |', 34).map(visible)
		expect(rows.some((r) => r.includes('identifier_name'))).toBe(true)
		expect(rows.filter((r) => r.startsWith('│')).length).toBeGreaterThan(2)
	})
})

describe('high-water mark', () => {
	afterEach(() => frame.state.peaks.clear())
	let hal = { at: 'stream' as const, lit: false, color: colors.assistant().fg! }
	let view = (session: string, text: string, streaming: boolean): View => {
		let transcript: Transcript = { meta: { id: session, cwd: '/', model: 'm', createdAt: '' }, state: { type: 'idle' }, inbox: [], items: [{ type: 'text', text, key: '~1' }] }
		return { transcript, prompt: { text: '', cursor: 0 }, hal: streaming ? hal : undefined }
	}
	let height = (v: View) => frame.build(v, 40).history

	test('a streaming block keeps its tallest height, also once it stops', () => {
		expect(height(view('s', 'a\nb\nc', true))).toBe(3)
		expect(height(view('s', 'a', true))).toBe(3)
		expect(height(view('s', 'a', false))).toBe(3)
		// Another tab's block, or the same one after a full redraw, starts afresh.
		expect(height(view('t', 'a', false))).toBe(1)
		frame.state.peaks.clear()
		expect(height(view('s', 'a', false))).toBe(1)
	})
})
