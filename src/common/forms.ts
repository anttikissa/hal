// Forms: the one way Hal asks a human something (tasks/w4/forms.md).
// A form is a list of fields; a durable question is a form in session
// history, answered from any client (first answer wins). This module
// holds what every client shares: the form's shape, checking and
// redacting answers, finding the open question in history, and the
// key handling of a form being filled in, as a pure function of
// (state, key) → state, so keys mean the same in terminal and web.

import type { HistoryRecord } from './replay.ts'
import { placeholders } from './placeholders.ts'

export type Field = { help?: string } & (
	// One line of text; may be left empty, or prefilled by the host.
	// A placeholder list rotates (placeholders.rotate), first one first.
	| { type: 'text'; name: string; label?: string; placeholder?: string | string[]; initial?: string }
	| { type: 'integer'; name: string; label?: string; initial?: string }
	// Never put a secret's current value in the form (it goes to history).
	| { type: 'secret'; name: string; label?: string }
	| { type: 'choice'; name: string; label?: string; options: string[]; initial?: number }
)

// `quote`: text shown as it is below the question (a command to
// approve), with `marks`, [start, end) offsets, highlighted.
export type Quote = { text: string; marks?: [number, number][] }

// `skip`: Escape skips the question (a canceled answer; whoever asked
// runs again and moves on) instead of pausing the turn.
export type Form = { text: string; quote?: Quote; fields: Field[]; skip?: true }

// Field name → value. A choice's value is one of its options.
export type Answers = Record<string, string>

// A key as both clients report it (the terminal's KeyEvent fits).
export type Key = { key: string; text?: string; shift?: boolean; ctrl?: boolean; alt?: boolean; cmd?: boolean }

// A form being filled in: one value per field, the focused field and
// the cursor (a UTF-16 offset on a grapheme boundary) in its text.
// `opened`: when this client showed it (Date.now()), the clock of
// rotating placeholders.
export type FormState = { id: string; form: Form; values: string[]; focus: number; cursor: number; opened?: number }

export type FormAction = { type: 'submit'; answers: Answers } | { type: 'cancel' }

type QuestionRecord = Extract<HistoryRecord, { type: 'question' }>

// Why `value` is not a usable form, or undefined if it is. Forms come
// from trusted host code, but a bad one must fail where it is made.
function invalid(value: unknown): string | undefined {
	let f = value as Form
	if (!f || typeof f.text !== 'string' || !Array.isArray(f.fields) || !f.fields.length) return 'a form needs text and fields'
	if (f.quote !== undefined) {
		let q = f.quote
		if (!q || typeof q.text !== 'string') return 'a quote needs text'
		let ok = (m: unknown) => Array.isArray(m) && m.length === 2 && Number.isInteger(m[0]) && Number.isInteger(m[1]) && 0 <= m[0] && m[0] <= m[1] && m[1] <= q.text.length
		if (q.marks !== undefined && (!Array.isArray(q.marks) || !q.marks.every(ok))) return 'quote marks must be [start, end] offsets into its text'
	}
	if (f.skip !== undefined && f.skip !== true) return 'skip must be true'
	let names = new Set<string>()
	for (let field of f.fields) {
		if (!field || typeof field.name !== 'string' || names.has(field.name)) return 'every field needs a unique name'
		names.add(field.name)
		if (field.type === 'choice') {
			if (!Array.isArray(field.options) || !field.options.length || field.options.some((o) => typeof o !== 'string')) return `${field.name}: choices need options`
		} else if (field.type !== 'text' && field.type !== 'secret' && field.type !== 'integer') return `${(field as Field).name}: unknown field type`
		if ((field.type === 'text' || field.type === 'integer') && field.initial !== undefined && typeof field.initial !== 'string') return `${field.name}: initial must be a string`
		if (field.help !== undefined && typeof field.help !== 'string') return `${field.name}: help must be a string`
		if (field.type === 'text' && field.placeholder !== undefined && typeof field.placeholder !== 'string' && !(Array.isArray(field.placeholder) && field.placeholder.every((p) => typeof p === 'string'))) return `${field.name}: placeholder must be a string or a list of strings`
	}
	return undefined
}

// Why `answers` do not answer `form`, or undefined if they do. Answers
// cross the wire, so the host checks them before recording anything.
function check(form: Form, answers: unknown): string | undefined {
	if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return 'answers must be an object'
	let a = answers as Record<string, unknown>
	for (let key of Object.keys(a)) if (!form.fields.some((f) => f.name === key)) return `no field named ${key}`
	for (let f of form.fields) {
		let v = a[f.name]
		if (typeof v !== 'string') return `${f.name}: answer must be a string`
		if (f.type === 'choice' && !f.options.includes(v)) return `${f.name}: not one of ${f.options.join(', ')}`
	}
	return undefined
}

// Answers as history keeps them: secrets left out, only named as given.
function redact(form: Form, answers: Answers): { answers: Answers; secrets?: string[] } {
	let kept: Answers = {}
	let secrets: string[] = []
	for (let f of form.fields) {
		if (f.type === 'secret') secrets.push(f.name)
		else kept[f.name] = answers[f.name]!
	}
	return secrets.length ? { answers: kept, secrets } : { answers: kept }
}

// The question waiting for an answer: the last one, if nothing answered
// it since. At most one is open at a time. A turn end (a pause) closes
// a turn's question; a command's lives beside turns and outlasts it.
function open(records: HistoryRecord[]): QuestionRecord | undefined {
	let ended = false
	for (let i = records.length - 1; i >= 0; i--) {
		let r = records[i]!
		if (r.type === 'question') return r.from || !ended ? r : undefined
		if (r.type === 'answer') return undefined
		if (r.type === 'turn_end') ended = true
	}
	return undefined
}

// A quote cut into its plain and marked parts, in order; overlapping
// marks merge.
function quoteParts(q: Quote): { text: string; marked: boolean }[] {
	let marks = [...(q.marks ?? [])].sort((a, b) => a[0] - b[0])
	let out: { text: string; marked: boolean }[] = []
	let at = 0
	let add = (to: number, marked: boolean) => {
		if (to > at) out.push({ text: q.text.slice(at, to), marked })
		at = Math.max(at, to)
	}
	for (let [from, to] of marks) {
		add(from, false)
		add(to, true)
	}
	add(q.text.length, false)
	return out
}

// A question answered, in one line per field: "Dave", "API key: (given)".
function summary(form: Form, answers: Answers, secrets: string[] = []): string[] {
	return form.fields.map((f) => {
		let value = secrets.includes(f.name) ? '(given)' : answers[f.name] || '(empty)'
		return f.label ? `${f.label}: ${value}` : value
	})
}

function start(id: string, form: Form): FormState {
	let values = form.fields.map((f) => (f.type === 'choice' ? f.options[Math.min(f.initial ?? 0, f.options.length - 1)]! : f.type === 'secret' ? '' : f.initial ?? ''))
	return { id, form, values, focus: 0, cursor: values[0]!.length, opened: Date.now() }
}

// The placeholder field `index` shows `now` (Date.now()); `next`: ms
// until it changes (Infinity: never, as for a plain string).
function example(st: FormState, index: number, now: number): { text: string; next: number } {
	let f = st.form.fields[index]
	let p = f?.type === 'text' ? f.placeholder : undefined
	return Array.isArray(p) ? placeholders.rotate(p, now - (st.opened ?? now)) : { text: p ?? '', next: Infinity }
}

// The form state for question `open` (the transcript's open one): the
// one being filled in if it is for that question, else a fresh one.
function follow(st: FormState | undefined, open: { id: string; form: Form } | undefined): FormState | undefined {
	if (!open) return undefined
	return st?.id === open.id ? st : forms.start(open.id, open.form)
}

// The value of a text or secret field set from outside (a browser input).
function set(st: FormState, index: number, value: string): FormState {
	let values = st.values.slice()
	values[index] = value
	return { ...st, values, focus: index, cursor: value.length }
}

const segmenter = new Intl.Segmenter()

function edges(text: string): number[] {
	return [...[...segmenter.segment(text)].map((s) => s.index), text.length]
}

function answers(st: FormState): Answers {
	return Object.fromEntries(st.form.fields.map((f, i) => [f.name, st.values[i]!]))
}

function focusOn(st: FormState, focus: number): FormState {
	let n = st.form.fields.length
	focus = (focus + n) % n
	return { ...st, focus, cursor: st.values[focus]!.length }
}

// What `key` does to the form. Enter moves to the next field and on
// the last one submits; Tab, Shift-Tab, up and down move between
// fields; Escape cancels (the client pauses the session). A choice's
// options stand in a column: up and down (left and right alike) move
// through them and past its ends to the field above or below. A typed
// initial picks an option, which on a one-field form also submits (y on
// y/N).
function step(st: FormState, key: Key): { state: FormState; action?: FormAction } {
	let field = st.form.fields[st.focus]!
	let last = st.focus === st.form.fields.length - 1
	let plain = !key.ctrl && !key.alt && !key.cmd
	let value = st.values[st.focus]!
	if (field.type === 'choice' && plain) {
		let at = field.options.indexOf(value)
		let move = key.key === 'up' || key.key === 'left' ? -1 : key.key === 'down' || key.key === 'right' ? 1 : 0
		let to = at + move
		if (move && to >= 0 && to < field.options.length) return { state: forms.set(st, st.focus, field.options[to]!) }
		// Past an end: the field above or below, if there is one.
		if (move && st.form.fields.length === 1) return { state: st }
		if (move) return { state: forms.focusOn(st, st.focus + move) }
	}
	switch (key.key) {
		case 'escape':
			return { state: st, action: { type: 'cancel' } }
		case 'enter':
			if (!plain) return { state: st }
			return last ? { state: st, action: { type: 'submit', answers: forms.answers(st) } } : { state: forms.focusOn(st, st.focus + 1) }
		case 'tab':
			return { state: forms.focusOn(st, st.focus + (key.shift ? -1 : 1)) }
		case 'down':
			return { state: forms.focusOn(st, st.focus + 1) }
		case 'up':
			return { state: forms.focusOn(st, st.focus - 1) }
	}
	if (field.type === 'choice') {
		let typed = plain && key.text?.toLowerCase()
		let pick = typed ? field.options.find((o) => o.toLowerCase().startsWith(typed)) : undefined
		if (!pick) return { state: st }
		let state = forms.set(st, st.focus, pick)
		return st.form.fields.length === 1 ? { state, action: { type: 'submit', answers: forms.answers(state) } } : { state }
	}
	let put = (text: string, cursor: number) => {
		let state = forms.set(st, st.focus, text)
		return { state: { ...state, cursor } }
	}
	let bounds = edges(value)
	let before = bounds.filter((b) => b < st.cursor).at(-1) ?? 0
	let after = bounds.find((b) => b > st.cursor) ?? value.length
	// The prompt's basic line keys: Ctrl-A/E ends, Ctrl-U/K clear before
	// or after the cursor, Alt-Backspace the word before it (Ctrl-W stays
	// the close-tab key).
	let chord = (key.ctrl ? 'C-' : key.alt ? 'M-' : '') + key.key
	switch (chord) {
		case 'left':
			return { state: { ...st, cursor: before } }
		case 'right':
			return { state: { ...st, cursor: after } }
		case 'home':
		case 'C-a':
			return { state: { ...st, cursor: 0 } }
		case 'end':
		case 'C-e':
			return { state: { ...st, cursor: value.length } }
		case 'C-u':
			return put(value.slice(st.cursor), 0)
		case 'C-k':
			return put(value.slice(0, st.cursor), st.cursor)
		case 'M-backspace': {
			let start = value.slice(0, st.cursor).search(/\S*\s*$/)
			return put(value.slice(0, start) + value.slice(st.cursor), start)
		}
		case 'backspace':
			return st.cursor ? put(value.slice(0, before) + value.slice(st.cursor), before) : { state: st }
		case 'delete':
			return put(value.slice(0, st.cursor) + value.slice(after), st.cursor)
	}
	let text = key.key === 'paste' || plain ? key.text : undefined
	if (!text) return { state: st }
	// One line: a pasted newline becomes a space.
	text = text.replace(/\r?\n|\r/g, ' ')
	return put(value.slice(0, st.cursor) + text + value.slice(st.cursor), st.cursor + text.length)
}

// The command a form action sends for session `sessionId`: the answer,
// or a pause for Escape.
function command(sessionId: string, st: FormState, action: FormAction): unknown {
	if (action.type === 'cancel') return { type: 'pause', sessionId }
	return { type: 'answer', sessionId, question: st.id, answers: action.answers }
}

export const forms = { invalid, check, redact, open, quoteParts, summary, start, follow, example, set, answers, focusOn, step, command }
