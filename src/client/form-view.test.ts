// Open questions in the frame (form-view.ts), seen through frame.build.
import { expect, test } from 'bun:test'
import { forms } from '../common/forms.ts'
import { strings } from '../common/strings.ts'
import type { Shown as Item, Transcript } from '../common/transcript.ts'
import { frame, type View } from './frame.ts'

// Visible text only: escape sequences removed.
function strip(s: string): string {
	let out = ''
	strings.walk(s, 0, (i, _w, len) => {
		out += s.slice(i, i + len)
	})
	return out
}

function view(items: Item[], text = '', cursor = text.length): View {
	let transcript: Transcript = { meta: { id: 's', cwd: '/', model: 'm', createdAt: '' }, state: { type: 'idle' }, inbox: [], items: items.map((item, i) => ({ ...item, key: `~${i}` })) }
	return { transcript, prompt: { text, cursor } }
}

// The frame without escape sequences and trailing blanks.
function plain(lines: string[]): string[] {
	return lines.map((l) => strip(l).trim())
}

const ask = { type: 'text' as const, name: 'name', label: 'Name', placeholder: 'leave empty' }
const secretForm = { text: 'Log in', fields: [{ type: 'secret' as const, name: 'key', label: 'Key' }, { type: 'choice' as const, name: 'ok', options: ['yes', 'no'] }] }

test('an open question shows its fields and takes the cursor into the focused text', () => {
	let item: Item = { type: 'question', id: 'q1', form: { text: 'How should I call you?', fields: [ask] } }
	let v = view([item], 'draft')
	let st = forms.step(forms.start('q1', item.form), { key: 'D', text: 'D' }).state
	let f = frame.build({ ...v, form: st }, 40)
	let rows = plain(f.lines)
	expect(rows[1]).toBe('How should I call you?')
	// Blank rows set the field apart from the question and the hint.
	expect(rows[2]).toBe('')
	expect(rows[3]).toBe('Name: D')
	expect(rows[4]).toBe('')
	// The cursor is just after the typed D, on the frame's row for it.
	expect(f.cursor).toEqual({ row: 3, col: strip(f.lines[3]!).indexOf('D') + 1 })
	// An empty text shows its placeholder; the prompt stays below.
	let empty = frame.build({ ...v, form: forms.start('q1', item.form) }, 40)
	expect(plain(empty.lines)[3]).toBe('Name: leave empty')
	expect(plain(empty.lines)).toContain('draft')
})

test('a secret is never on screen; the chosen option is marked', () => {
	let item: Item = { type: 'question', id: 'q1', form: secretForm }
	let st = forms.start('q1', secretForm)
	for (let c of 'sk-éé') st = forms.step(st, { key: c, text: c }).state
	let f = frame.build({ ...view([item]), form: st }, 40)
	expect(f.lines.join('\n')).not.toContain('sk-')
	expect(plain(f.lines)[3]).toBe('Key: •••••')
	expect(plain(f.lines)[4]).toBe('→ yes')
	expect(plain(f.lines)[5]).toBe('no')
})

test('an answered question shows its answers, secrets only as given; one not answered says so', () => {
	let done: Item = { type: 'question', id: 'q1', form: secretForm, answers: { ok: 'yes' }, secrets: ['key'] }
	expect(plain(frame.build(view([done]), 40).lines).slice(0, 4)).toEqual(['', 'Log in', '', 'Key: (given)'])
	let left: Item = { type: 'question', id: 'q1', form: secretForm }
	expect(plain(frame.build(view([left]), 40).lines).slice(0, 4)).toEqual(['', 'Log in', '', '(not answered)'])
})

test('a quote shows under the question with its marked part highlighted on every row it wraps to', () => {
	let command = 'cd build && rm -rf everything-in-this-directory'
	let from = command.indexOf('rm')
	let form = { text: 'Run this?', quote: { text: command, marks: [[from, command.length]] as [number, number][] }, fields: [{ type: 'choice' as const, name: 'run', options: ['yes', 'no'], initial: 1 }] }
	let item: Item = { type: 'question', id: 'q1', form }
	let open = frame.build({ ...view([item]), form: forms.start('q1', form) }, 30).lines
	let answered = frame.build(view([{ ...item, answers: { run: 'no' } }]), 30).lines
	for (let lines of [open, answered]) {
		// Quote rows are indented past the answer rows.
		let rows = lines.filter((l) => strip(l).startsWith(' '.repeat(5)) && strip(l).trim() !== '' && !strip(l).includes('/keys'))
		expect(rows.length).toBe(3)
		expect(rows.map((r) => strip(r).trim()).join(' ').replace(/\s+/g, ' ')).toContain('cd build && rm -rf')
		// Marked text is inverse; every row ends it, so nothing bleeds.
		expect(rows[0]).toContain('\x1b[7mrm')
		expect(rows[0]).not.toContain('\x1b[7mcd')
		for (let row of rows.slice(1)) expect(row).toContain('\x1b[7m')
		for (let row of rows) expect(row.lastIndexOf('\x1b[7m')).toBeLessThan(row.lastIndexOf('\x1b[27m'))
	}
	expect(plain(answered)).toContain('no')
})

test('a cached question gains visible choices when its blocked state arrives', () => {
	frame.state.history = undefined
	let form = { text: 'Continue?', fields: [{ type: 'choice' as const, name: 'go', options: ['Yes', 'No'] }] }
	let v = view([{ type: 'question', id: 'q1', form }])
	// The question event precedes the blocked-state event. Its first
	// frame has no active form, but the second uses the same item.
	frame.build(v, 40)
	let st = forms.start('q1', form)
	let open = frame.build({ ...v, form: st }, 40)
	expect(plain(open.lines)).toContain('→ Yes')
	expect(plain(open.lines)).toContain('No')
	expect(plain(open.lines)[open.cursor.row]).toBe('→ Yes')
	st = forms.step(st, { key: 'down' }).state
	let moved = frame.build({ ...v, form: st }, 40)
	expect(plain(moved.lines)[moved.cursor.row]).toBe('→ No')
	frame.state.history = undefined
})
