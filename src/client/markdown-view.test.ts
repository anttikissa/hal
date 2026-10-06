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
	test('a two-line cell puts the bar over the reset text in one row', () => {
		let rows = markdownView.lines('| Account | 5h |\n|---|---|\n| alice | █████<br>95% used (resets 23:39) |', 64).map(visible)
		expect(rows.some((r) => r.includes('█████') && r.includes('alice'))).toBe(true)
		expect(rows.some((r) => r.includes('95% used (resets 23:39)') && !r.includes('alice'))).toBe(true)
		expect(rows.join('')).not.toContain('<br>')
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
		let tall = height(view('s', 'a\nb\nc', true))
		expect(height(view('s', 'a', true))).toBe(tall)
		expect(height(view('s', 'a', false))).toBe(tall)
		// Another tab's block, or the same one after a full redraw, starts afresh.
		let short = height(view('t', 'a', false))
		expect(short).toBe(tall - 2)
		frame.state.peaks.clear()
		expect(height(view('s', 'a', false))).toBe(short)
	})
})

describe('tool card high-water mark', () => {
	afterEach(() => frame.state.peaks.clear())
	let input = { command: 'seq 9', description: 'Count' }
	let view = (items: any[], folds?: View['folds']): View => ({ transcript: { meta: { id: 'c', cwd: '/', model: 'm', createdAt: '' }, state: { type: 'idle' }, inbox: [], items }, prompt: { text: '', cursor: 0 }, folds })
	let height = (v: View) => frame.build(v, 40).history
	let output = '1\n2\n3\n4\n5\n6\n7\n8\n9\n'

	test('a finished call with its result is never shorter than while it ran', () => {
		let running = height(view([{ type: 'tool', id: 'x', name: 'bash', input, partial: output, key: '3' }]))
		let done = view([{ type: 'tool', id: 'x', name: 'bash', input, key: '3' }, { type: 'tool-result', id: 'x', output: `[exit 0]\n${output}`, key: '4' }])
		expect(height(done)).toBe(running)
		// A full redraw forgets the mark, as render.draw(true) does.
		frame.state.peaks.clear()
		frame.state.history = undefined
		expect(height(done)).toBeLessThan(running)
	})
})
