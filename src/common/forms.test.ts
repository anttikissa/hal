import { expect, test } from 'bun:test'
import { forms, type Form, type FormState, type Key } from './forms.ts'
import type { HistoryRecord } from './replay.ts'

const name: Form = { text: 'How should I call you?', fields: [{ type: 'text', name: 'name', placeholder: 'leave empty to stay nameless' }] }
const yesNo: Form = { text: 'Create it?', fields: [{ type: 'choice', name: 'ok', options: ['yes', 'no'], initial: 1 }] }
const login: Form = {
	text: 'Log in',
	fields: [
		{ type: 'text', name: 'user', label: 'User' },
		{ type: 'secret', name: 'key', label: 'API key' },
		{ type: 'choice', name: 'save', label: 'Remember', options: ['yes', 'no'] },
	],
}

const k = (key: string, text?: string, mods: Partial<Key> = {}): Key => ({ key, ...(text === undefined ? {} : { text }), ...mods })
const typed = (s: string) => [...s].map((c) => k(c, c))

// Presses keys in order; the last action, if any.
function press(st: FormState, keys: Key[]) {
	let action
	for (let key of keys) ({ state: st, action } = forms.step(st, key))
	return { st, action }
}

test('a text answer is typed, edited by grapheme and submitted with Enter', () => {
	let { st, action } = press(forms.start('q1', name), [...typed('Dav'), k('paste', 'e👍🏽'), k('backspace'), k('left'), k('home'), k('x', 'x'), k('enter')])
	expect(action).toEqual({ type: 'submit', answers: { name: 'xDave' } })
	expect(st.values).toEqual(['xDave'])
})

test('an empty text is a valid answer', () => {
	expect(press(forms.start('q1', name), [k('enter')]).action).toEqual({ type: 'submit', answers: { name: '' } })
})

test('a pasted newline stays one line', () => {
	expect(press(forms.start('q1', name), [k('paste', 'a\nb'), k('enter')]).action).toEqual({ type: 'submit', answers: { name: 'a b' } })
})

test('y/N: Enter takes the default, y answers at once, arrows change it', () => {
	let start = forms.start('q1', yesNo)
	expect(press(start, [k('enter')]).action).toEqual({ type: 'submit', answers: { ok: 'no' } })
	expect(press(start, [k('y', 'y')]).action).toEqual({ type: 'submit', answers: { ok: 'yes' } })
	expect(press(start, [k('Y', 'Y')]).action).toEqual({ type: 'submit', answers: { ok: 'yes' } })
	expect(press(start, [k('left'), k('enter')]).action).toEqual({ type: 'submit', answers: { ok: 'yes' } })
	// Other keys do nothing, ctrl ones included.
	expect(press(start, [k('q', 'q'), k('y', 'y', { ctrl: true })]).action).toBeUndefined()
})

test('a single option is "press Enter"', () => {
	let form: Form = { text: 'Welcome', fields: [{ type: 'choice', name: 'go', options: ['continue'] }] }
	expect(press(forms.start('q', form), [k('right'), k('enter')]).action).toEqual({ type: 'submit', answers: { go: 'continue' } })
})

test('several fields: Enter and Tab go to the next, Shift-Tab and up back; the last Enter submits', () => {
	let { st, action } = press(forms.start('q', login), [...typed('ann'), k('enter'), ...typed('sk-1'), k('tab'), k('n', 'n')])
	// A typed initial on a multi-field form only selects.
	expect(action).toBeUndefined()
	expect(st.focus).toBe(2)
	;({ st, action } = press(st, [k('tab', undefined, { shift: true }), k('backspace'), k('up'), k('end'), ...typed('e'), k('down'), k('down'), k('enter')]))
	expect(action).toEqual({ type: 'submit', answers: { user: 'anne', key: 'sk-', save: 'no' } })
})

test('Escape cancels; the client sends a pause', () => {
	let st = forms.start('q1', name)
	let { action } = forms.step(st, k('escape'))
	expect(action).toEqual({ type: 'cancel' })
	expect(forms.command('s1', st, action!)).toEqual({ type: 'pause', sessionId: 's1' })
	expect(forms.command('s1', st, { type: 'submit', answers: { name: 'D' } })).toEqual({ type: 'answer', sessionId: 's1', question: 'q1', answers: { name: 'D' } })
})

test('check refuses answers that do not fit the form', () => {
	let ok = { user: 'a', key: 'k', save: 'no' }
	expect(forms.check(login, ok)).toBeUndefined()
	expect(forms.check(login, { ...ok, save: 'maybe' })).toBeString()
	expect(forms.check(login, { user: 'a', key: 'k' })).toBeString()
	expect(forms.check(login, { ...ok, extra: 'x' })).toBeString()
	expect(forms.check(login, { ...ok, user: 1 })).toBeString()
	expect(forms.check(login, null)).toBeString()
	expect(forms.check(login, ['a'])).toBeString()
})

test('invalid refuses forms no client could fill in', () => {
	expect(forms.invalid(login)).toBeUndefined()
	expect(forms.invalid({ text: 'x', fields: [] })).toBeString()
	expect(forms.invalid({ text: 'x', fields: [{ type: 'choice', name: 'a', options: [] }] })).toBeString()
	expect(forms.invalid({ text: 'x', fields: [{ type: 'text', name: 'a' }, { type: 'text', name: 'a' }] })).toBeString()
	let field = { type: 'text' as const, name: 'a' }
	expect(forms.invalid({ text: 'x', quote: { text: 'rm -rf x', marks: [[0, 8]] }, fields: [field] })).toBeUndefined()
	for (let marks of [[[0, 9]], [[3, 2]], [[-1, 2]], [[0.5, 2]], [0, 1]] as any[]) {
		expect(forms.invalid({ text: 'x', quote: { text: 'rm -rf x', marks }, fields: [field] })).toBeString()
	}
})

test('history keeps only that a secret was given', () => {
	let kept = forms.redact(login, { user: 'a', key: 'sk-secret', save: 'no' })
	expect(JSON.stringify(kept)).not.toContain('sk-secret')
	expect(forms.summary(login, kept.answers, kept.secrets)).toEqual(['User: a', 'API key: (given)', 'Remember: no'])
})

const ts = '2026-01-01T00:00:00.000Z'
const q = (id: string): HistoryRecord => ({ type: 'question', id, form: name, ts })

test('the open question is the last one in the unfinished turn, until answered', () => {
	let prompt: HistoryRecord = { type: 'user', blocks: [{ type: 'text', text: 'hi' }], ts }
	expect(forms.open([prompt, q('q1')])?.id).toBe('q1')
	expect(forms.open([prompt, q('q1'), { type: 'answer', question: 'q1', answers: { name: '' }, ts }])).toBeUndefined()
	expect(forms.open([prompt, q('q1'), { type: 'turn_end', status: 'paused', usage: {}, ts }])).toBeUndefined()
	expect(forms.open([prompt])).toBeUndefined()
})

test('a client keeps what was typed while the same question is open, and starts afresh for the next', () => {
	let typedIn = press(forms.start('q1', name), typed('Da')).st
	expect(forms.follow(typedIn, { id: 'q1', form: name })).toBe(typedIn)
	expect(forms.follow(typedIn, { id: 'q2', form: name })?.values).toEqual([''])
	expect(forms.follow(typedIn, undefined)).toBeUndefined()
})

test('a quote cuts into plain and marked parts in order, overlapping marks merged', () => {
	let parts = forms.quoteParts({ text: 'ls; rm -rf a; git reset --hard', marks: [[14, 30], [4, 12], [6, 9]] })
	expect(parts).toEqual([
		{ text: 'ls; ', marked: false },
		{ text: 'rm -rf a', marked: true },
		{ text: '; ', marked: false },
		{ text: 'git reset --hard', marked: true },
	])
	expect(forms.quoteParts({ text: 'ls' })).toEqual([{ text: 'ls', marked: false }])
})
