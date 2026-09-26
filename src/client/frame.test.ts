import { expect, test } from 'bun:test'
import { colors } from '../common/colors.ts'
import { forms } from '../common/forms.ts'
import { oklch, type Oklch } from '../common/oklch.ts'
import { strings } from '../common/strings.ts'
import type { Item, Transcript } from '../common/transcript.ts'
import { frame, type View } from './frame.ts'

const DIM = '\x1b[2m'

// Visible text only: escape sequences removed.
function strip(s: string): string {
	let out = ''
	strings.walk(s, 0, (i, _w, len) => {
		out += s.slice(i, i + len)
	})
	return out
}

function view(items: Item[], text = '', cursor = text.length): View {
	let transcript: Transcript = { meta: { id: 's', cwd: '/', model: 'm', createdAt: '' }, state: { type: 'idle' }, inbox: [], items }
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
		{ type: 'tool', id: 't', name: 'bash', input: { command: text, description: text } },
		{ type: 'tool-result', id: 't', output: text },
		{ type: 'tool-result', id: 't', output: text, isError: true },
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

test('a described command shows its description first and the command dimmed beside it', () => {
	let input = { command: "sed -n '1,40p' config.ason |\n  cat -n", description: 'Show the first 40 lines of the config' }
	let [line] = frame.build(view([{ type: 'tool', id: 't', name: 'bash', input }]), 100).lines
	let [before, after] = line!.split(DIM)
	expect(strip(before!)).toContain('Show the first 40 lines of the config')
	expect(strip(before!)).not.toContain('sed')
	expect(strip(after!)).toContain("sed -n '1,40p' config.ason | cat -n")
})

test('a long tool result shows only its first rows', () => {
	let output = Array.from({ length: 100 }, (_, i) => `row ${i}`).join('\n')
	let lines = plain(frame.build(view([{ type: 'tool-result', id: 't', output }]), 40).lines)
	expect(lines.join('\n')).toContain('row 0')
	expect(lines.join('\n')).not.toContain('row 50')
	expect(lines.length).toBeLessThan(10)
})

test('text cannot send escape sequences to the terminal', () => {
	let f = frame.build(view([{ type: 'text', text: 'hi\x1b[2J\x1b]0;title\x07\r\nthere' }], 'a\x1bb'), 40)
	for (let line of f.lines) for (let c of ['\x07', '\r']) expect(line).not.toContain(c)
	// Only colour (SGR) sequences are left, which move nothing.
	for (let line of f.lines) for (let esc of line.split('\x1b').slice(1)) expect(esc).toMatch(/^\[[\d;]*m/)
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
	expect(rows.map(strip).join('').replace(/[ >]/g, '')).toBe(text.replace('\n', ''))
	expect(f.cursor.row).toBe(f.lines.length - 1)
	let lastRow = f.lines.at(-1)!
	expect(f.cursor.col).toBe(strip(lastRow).trimEnd().length)

	let start = frame.build(view([], text, 6), 20)
	expect(strip(start.lines[start.cursor.row]!).slice(start.cursor.col)).toMatch(/^x/)
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

// Truecolor SGR parameters for a colour, as the terminal gets them.
const fgOf = (c: Oklch) => `38;2;${oklch.toRgb(c).join(';')}`
const bgOf = (c: Oklch) => `48;2;${oklch.toRgb(c).join(';')}`
const rowWith = (lines: string[], text: string) => lines.find((l) => strip(l).includes(text))!

test('items wear their theme colours', () => {
	let items: Item[] = [
		{ type: 'prompt', text: 'ask' },
		{ type: 'thinking', text: 'ponder' },
		{ type: 'text', text: 'reply' },
		{ type: 'tool', id: 't', name: 'bash', input: { command: 'ls' } },
		{ type: 'tool', id: 'u', name: 'mystery', input: {} },
		{ type: 'turn-end', status: 'error', error: 'boom' },
	]
	let lines = frame.build(view(items, 'typed'), 60).lines
	expect(rowWith(lines, 'ask')).toContain(fgOf(colors.user().fg!))
	expect(rowWith(lines, 'ponder')).toContain(fgOf(colors.thinking().fg!))
	expect(rowWith(lines, 'reply')).toContain(fgOf(colors.assistant().fg!))
	expect(rowWith(lines, 'ls')).toContain(bgOf(colors.toolBash().bg!))
	expect(rowWith(lines, 'mystery')).toContain(bgOf(colors.tool().bg!))
	expect(rowWith(lines, 'boom')).toContain(fgOf(colors.error().fg!))
	expect(rowWith(lines, 'typed')).toContain(bgOf(colors.input().bg!))
})

test('a card background fills the whole row and colour ends with the row', () => {
	let f = frame.build(view([{ type: 'prompt', text: 'short\nlines' }], 'typed'), 30)
	for (let text of ['short', 'lines', 'typed']) {
		let row = rowWith(f.lines, text)
		expect(strings.visLen(row)).toBe(30)
		expect(row.startsWith('\x1b[')).toBe(true)
		expect(row.endsWith('\x1b[39;49m')).toBe(true)
	}
	// The cursor still sits right after the typed text.
	let row = f.lines[f.cursor.row]!
	expect(f.cursor.col).toBe(strings.visLen(row.slice(0, row.indexOf('typed') + 5)))
})

test('the terminal follows a theme override at the next build', () => {
	let saved = colors.fgL
	try {
		colors.fgL = 0.95
		let row = rowWith(frame.build(view([{ type: 'text', text: 'reply' }]), 40).lines, 'reply')
		expect(row).toContain(fgOf([0.95, colors.fgC, 55]))
	} finally {
		colors.fgL = saved
	}
})

const ask = { type: 'text' as const, name: 'name', label: 'Name', placeholder: 'leave empty' }
const secretForm = { text: 'Log in', fields: [{ type: 'secret' as const, name: 'key', label: 'Key' }, { type: 'choice' as const, name: 'ok', options: ['yes', 'no'] }] }

test('an open question shows its fields and takes the cursor into the focused text', () => {
	let item: Item = { type: 'question', id: 'q1', form: { text: 'How should I call you?', fields: [ask] } }
	let v = view([item], 'draft')
	let st = forms.step(forms.start('q1', item.form), { key: 'D', text: 'D' }).state
	let f = frame.build({ ...v, form: st }, 40)
	let rows = plain(f.lines)
	expect(rows[0]).toBe('? How should I call you?')
	expect(rows[1]).toBe('Name: D')
	// The cursor is just after the typed D, on the frame's row for it.
	expect(f.cursor).toEqual({ row: 1, col: strip(f.lines[1]!).indexOf('D') + 1 })
	// An empty text shows its placeholder; the prompt stays below.
	let empty = frame.build({ ...v, form: forms.start('q1', item.form) }, 40)
	expect(plain(empty.lines)[1]).toBe('Name: leave empty')
	expect(plain(empty.lines).at(-1)).toBe('> draft')
})

test('a secret is never on screen; the chosen option is marked', () => {
	let item: Item = { type: 'question', id: 'q1', form: secretForm }
	let st = forms.start('q1', secretForm)
	for (let c of 'sk-éé') st = forms.step(st, { key: c, text: c }).state
	let f = frame.build({ ...view([item]), form: st }, 40)
	expect(f.lines.join('\n')).not.toContain('sk-')
	expect(plain(f.lines)[1]).toBe('Key: •••••')
	expect(f.lines[2]).toContain('\x1b[7m yes \x1b[27m')
})

test('an answered question shows its answers, secrets only as given; one not answered says so', () => {
	let done: Item = { type: 'question', id: 'q1', form: secretForm, answers: { ok: 'yes' }, secrets: ['key'] }
	expect(plain(frame.build(view([done]), 40).lines).slice(0, 3)).toEqual(['? Log in', 'Key: (given)', 'yes'])
	let left: Item = { type: 'question', id: 'q1', form: secretForm }
	expect(plain(frame.build(view([left]), 40).lines).slice(0, 2)).toEqual(['? Log in', '(not answered)'])
})
