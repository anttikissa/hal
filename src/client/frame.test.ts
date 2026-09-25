import { expect, test } from 'bun:test'
import { strings } from '../common/strings.ts'
import type { Item, Transcript } from '../common/transcript.ts'
import { frame, type View } from './frame.ts'

const DIM = '\x1b[2m'
const UNDIM = '\x1b[22m'

// Visible text only: escape sequences removed.
function strip(s: string): string {
	let out = ''
	strings.walk(s, 0, (i, _w, len) => {
		out += s.slice(i, i + len)
	})
	return out
}

function view(items: Item[], text = '', cursor = text.length): View {
	let transcript: Transcript = { meta: { id: 's', cwd: '/', model: 'm', createdAt: '' }, items }
	return { transcript, prompt: { text, cursor } }
}

// The frame without escape sequences and trailing blanks.
function plain(lines: string[]): string[] {
	return lines.map((l) => strip(l).trim())
}

test('shows every item, however long the history', () => {
	let items: Item[] = []
	for (let i = 0; i < 300; i++) items.push({ type: 'prompt', text: `question ${i}` }, { type: 'text', text: `answer ${i}` })
	let lines = plain(frame.build(view(items), 40).lines)
	expect(lines).toContain('> question 0')
	expect(lines).toContain('answer 0')
	expect(lines).toContain('answer 299')
	expect(lines.filter((l) => l.startsWith('answer')).length).toBe(300)
})

test('no row is wider than the terminal, whatever the text', () => {
	let text = 'wide 漢字漢字漢字 and e\u0301 combining, 👨‍👩‍👧 emoji,\ttabs\tand a verylongwordthatcannotfitanywhere at all'
	let items: Item[] = [
		{ type: 'prompt', text },
		{ type: 'thinking', text },
		{ type: 'text', text },
		{ type: 'tool', id: 't', name: 'bash', input: { command: text } },
		{ type: 'turn-end', status: 'error', error: text },
	]
	for (let cols = 6; cols < 50; cols++) {
		let f = frame.build(view(items, text), cols)
		for (let line of f.lines) {
			expect(strings.visLen(line)).toBeLessThanOrEqual(cols)
			expect(line).not.toContain('\t')
		}
		expect(f.cursor.col).toBeLessThan(cols)
	}
})

test('text cannot send escape sequences to the terminal', () => {
	let f = frame.build(view([{ type: 'text', text: 'hi\x1b[2J\x1b]0;title\x07\r\nthere' }], 'a\x1bb'), 40)
	for (let line of f.lines) for (let c of ['\x07', '\r']) expect(line).not.toContain(c)
	for (let line of f.lines) expect(strip(line)).toBe(line.replaceAll(DIM, '').replaceAll(UNDIM, ''))
	expect(plain(f.lines)).toContain('there')
})

test('the prompt is last and the cursor sits where the prompt cursor is', () => {
	let f = frame.build(view([{ type: 'text', text: 'hello' }], 'ab漢cd', 3), 40)
	let last = f.lines.length - 1
	expect(f.cursor.row).toBe(last)
	// The cursor is right after "ab漢": its column is the width of the row up to there.
	let row = f.lines[last]!
	expect(f.cursor.col).toBe(strings.visLen(row.slice(0, row.indexOf('cd'))))
})

test('prompt cursor follows newlines and wrapping', () => {
	let text = 'first\n' + 'x'.repeat(30)
	let f = frame.build(view([], text), 20)
	// Two logical lines; the second wraps; the cursor is at its very end.
	let rows = f.lines.slice(f.lines.findIndex((l) => l.includes('first')))
	expect(rows.join('').replace(/[ >]/g, '')).toBe(text.replace('\n', ''))
	expect(f.cursor.row).toBe(f.lines.length - 1)
	let lastRow = f.lines.at(-1)!
	expect(f.cursor.col).toBe(strings.visLen(lastRow.trimEnd()))

	let start = frame.build(view([], text, 6), 20)
	expect(start.lines[start.cursor.row]!.slice(start.cursor.col)).toMatch(/^x/)
})

test('a cursor after a full prompt row stays inside the terminal', () => {
	// 20 columns: 1 pad + "> " + 16 text + 1 pad.
	let f = frame.build(view([], 'y'.repeat(16)), 20)
	expect(f.lines.length).toBe(1)
	expect(f.cursor).toEqual({ row: 0, col: 19 })
})

test('an empty session is just the prompt', () => {
	let f = frame.build({ prompt: { text: '', cursor: 0 } }, 80)
	expect(plain(f.lines)).toEqual(['>'])
	expect(f.cursor).toEqual({ row: 0, col: 3 })
})

test('a notice sits between the transcript and the prompt, wrapped and cleaned', () => {
	let v = view([{ type: 'text', text: 'answer' }], 'typed')
	v.notice = 'refused: a turn is already running\x1b[2J in this session'
	let f = frame.build(v, 20)
	let lines = plain(f.lines)
	let at = lines.findIndex((l) => l.startsWith('refused'))
	expect(at).toBeGreaterThan(lines.indexOf('answer'))
	expect(lines.at(-1)).toBe('> typed')
	expect(lines.join(' ')).toContain('in this session')
	for (let line of f.lines) {
		expect(strings.visLen(line)).toBeLessThanOrEqual(20)
		expect(strip(line)).not.toContain('\x1b')
	}
	expect(f.cursor.row).toBe(f.lines.length - 1)
})
