// The web controller with the message box: sending, drafts, editing the
// last prompt, questions, the model picker, settings and editing keys.

import { expect, test } from 'bun:test'
import { connection } from '../common/connection.ts'
import { drafts } from '../common/drafts.ts'
import type { Event } from '../common/protocol.ts'
import { app } from './app.ts'
import { keys, type Target } from './keys.ts'
import { folds } from './folds.ts'
import { useApp, fx, message, press, sessionId, snapshot, ts } from './app-fixture.test.ts'

useApp()

test('Ctrl-O p expands draft pastes without sending the draft', () => {
	app.onEvent(snapshot({ type: 'idle' }))
	app.input('before [paste/abcdef.txt] after')
	folds.open()
	folds.input('p')
	folds.key({ key: 'enter' })
	expect(app.state.view.modal).toBeDefined()
	app.onEvent({ type: 'paste-text', sessionId, name: 'abcdef.txt', text: 'first\nlast' })
	expect(app.state.view.modal?.blocks?.hint).toBe('Replace 1 paste marker with their contents (2 lines).')
	folds.key({ key: 'enter' })
	expect(app.state.view.modal).toBeUndefined()
	expect(app.state.text).toBe('before first\nlast after')
	expect(drafts.text(sessionId)).toBe(app.state.text)
	expect(fx.sent.some((c) => c.type === 'submit')).toBe(false)
})

test('Enter sends the message box as a prompt: it shows pending and the box empties', () => {
	app.onEvent(snapshot({ type: 'idle' }))
	// Text put in the box without an input event is what gets sent.
	expect(press('Enter', message('hi'))).toBe(true)
	expect(fx.sent.find((c) => c.type === 'submit')).toMatchObject({ sessionId, text: 'hi' })
	expect(app.pending().map((s) => s.text)).toEqual(['hi'])
	expect(app.state.text).toBe('')
	expect(fx.redraws).toBeGreaterThan(0)
	// Acknowledged, it is no longer pending.
	let id = fx.sent.find((c) => c.type === 'submit').id
	app.onEvent({ type: 'ack', id } as Event)
	expect(app.pending()).toEqual([])
})

test('Shift+Enter is a newline; Enter before a session exists keeps the text with a notice', () => {
	expect(press('Enter', message('hi'), { shiftKey: true })).toBe(false)
	expect(press('Enter', message('hi'))).toBe(true)
	expect(app.state.text).toBe('hi')
	expect(app.notice()).toBeTruthy()
	expect(fx.sent.filter((c) => c.type === 'submit')).toEqual([])
})

test('typing is the session draft, and a snapshot brings the kept draft back', () => {
	app.onEvent(snapshot({ type: 'idle' }, [], { text: 'from host', rev: 3 }))
	expect(app.state.text).toBe('from host')
	app.input('mine')
	expect(fx.stored.get(sessionId)?.text).toBe('mine')
	expect(fx.sent.some((c) => c.type === 'draft' && c.text === 'mine')).toBe(true)
})

test('Up on the first row while the model works edits the last prompt; Down unchanged brings the draft back', () => {
	app.onEvent(
		snapshot({ type: 'running', phase: 'streaming' }, [
			{ type: 'user', blocks: [{ type: 'text', text: 'fix ti' }], ts },
		]),
	)
	app.input('draft\nmore')
	expect(press('ArrowUp', message('draft\nmore'))).toBe(false)
	expect(press('ArrowUp', message('draft\nmore', 2))).toBe(true)
	expect(app.state.text).toBe('fix ti')
	expect(fx.sent.at(-1)).toMatchObject({ type: 'pause', sessionId })
	expect(app.state.view.editing).toBeDefined()
	expect(press('ArrowDown', message('fix ti'))).toBe(true)
	expect(app.state.text).toBe('draft\nmore')
	expect(app.state.view.editing).toBeUndefined()
})

test('an open question takes the keys: fields type natively, Enter answers', () => {
	let form = { text: 'Name?', fields: [{ type: 'text' as const, name: 'name' }] }
	app.onEvent(snapshot({ type: 'blocked', reason: 'question' }))
	app.onEvent({ type: 'question', sessionId, id: 'q1', form })
	expect(press('a', { kind: 'field' })).toBe(false)
	app.formInput(0, 'Ann')
	expect(press('Enter', { kind: 'field' })).toBe(true)
	expect(fx.sent.at(-1)).toMatchObject({ type: 'answer', sessionId, question: 'q1', answers: { name: 'Ann' } })
})

test('an open choice question leaves Cmd and Ctrl keys to the browser; a letter picks', () => {
	let form = { text: 'Method?', fields: [{ type: 'choice' as const, name: 'm', options: ['Claude', 'Router'] }] }
	app.onEvent(snapshot({ type: 'blocked', reason: 'question' }))
	app.onEvent({ type: 'question', sessionId, id: 'q1', form })
	for (let [key, mods] of [
		['r', { metaKey: true }],
		['l', { metaKey: true }],
		['a', { ctrlKey: true }],
	] as const)
		expect(press(key, { kind: 'button', submits: false }, mods)).toBe(false)
	expect(fx.sent.filter((c) => c.type === 'answer')).toEqual([])
	expect(press('r', { kind: 'button', submits: false })).toBe(true)
	expect(fx.sent.at(-1)).toMatchObject({ type: 'answer', answers: { m: 'Router' } })
})

test('a click on an option of a one-field question answers it, unless disconnected', () => {
	let form = { text: 'Ok?', fields: [{ type: 'choice' as const, name: 'ok', options: ['yes', 'no'] }] }
	app.onEvent(snapshot({ type: 'blocked', reason: 'question' }))
	app.onEvent({ type: 'question', sessionId, id: 'q1', form })
	connection.connected = () => false
	app.pick(0, 'yes')
	expect(fx.sent.filter((c) => c.type === 'answer')).toEqual([])
	expect(app.notice()).toMatch(/not connected/)
	connection.connected = () => true
	app.pick(0, 'no')
	expect(fx.sent.at(-1)).toMatchObject({ type: 'answer', question: 'q1', answers: { ok: 'no' } })
})

test('Ctrl-M asks for models; the picker takes the keys and a click picks', () => {
	app.onEvent(snapshot({ type: 'idle' }))
	expect(press('m', message(''), { ctrlKey: true })).toBe(true)
	expect(fx.sent.at(-1)).toMatchObject({ type: 'models', sessionId })
	app.onEvent({ type: 'models', sessionId, current: 'fake/m', items: ['fake/m', 'x/y'] })
	expect(app.state.view.modal).toBeDefined()
	// Plain keys go to the search box.
	expect(press('x', { kind: 'other' })).toBe(false)
	// A tap on a category without a default opens it; then on its model.
	app.modalPick(app.state.view.modal!.items.indexOf('▶ x'))
	expect(fx.sent.at(-1)).toMatchObject({ type: 'models' })
	app.modalPick(app.state.view.modal!.items.findIndex((item) => item.includes('x/y')))
	expect(fx.sent.at(-1)).toMatchObject({ type: 'submit', text: '/model x/y' })
	expect(app.state.view.modal).toBeUndefined()
})

test('settings arrows adjust values but leave inline editing native', () => {
	app.onEvent(snapshot({ type: 'idle' }))
	app.onEvent({ type: 'settings', sessionId, values: { subagentSlots: '3' }, stored: {} })
	expect(press('ArrowRight', { kind: 'field' })).toBe(true)
	expect(fx.sent.at(-1)).toMatchObject({ type: 'submit', text: '/config subagentSlots 4' })
	press('Enter', { kind: 'field' })
	let count = fx.sent.length
	expect(press('ArrowLeft', { kind: 'field' })).toBe(false)
	expect(fx.sent).toHaveLength(count)
})

test('the link state leaves the notice to the status line and clears it on connect', () => {
	app.setNotice('not connected; try again in a moment')
	app.onState({ type: 'joining' })
	app.onState({ type: 'disconnected', retryAt: 0 })
	expect(app.notice()).toBe('not connected; try again in a moment')
	app.onState({ type: 'connected', role: 'client' })
	expect(app.notice()).toBeUndefined()
})

test('Ctrl-K, Ctrl-U, Alt-D, Alt-Backspace and Ctrl-Y edit the box through the shared editor, as native edits', () => {
	app.onEvent(snapshot({ type: 'idle' }))
	let edits: unknown[] = []
	let box = (text: string, cursor: number): Target => ({
		kind: 'message',
		text,
		cursor,
		write: (e, at) => void edits.push([e, at]),
	})
	expect(press('k', box('hello world', 5), { ctrlKey: true })).toBe(true)
	expect(app.state.text).toBe('hello')
	expect(edits).toEqual([[{ start: 5, end: 11, text: '' }, 5]])
	expect(press('y', box('hello', 0), { ctrlKey: true })).toBe(true)
	expect(app.state.text).toBe(' worldhello')
	expect(edits[1]).toEqual([{ start: 0, end: 0, text: ' world' }, 6])
	// The draft follows the box.
	expect(drafts.text(sessionId)).toBe(' worldhello')
	// macOS Option-D types ∂; the physical key still makes it Alt-D.
	keys.key({ key: '∂', code: 'KeyD', shiftKey: false, ctrlKey: false, altKey: true, metaKey: false }, box('ab cd', 2))
	expect(app.state.text).toBe('ab')
	press('u', box('ab', 1), { ctrlKey: true })
	expect(app.state.text).toBe('b')
	press('y', box('b', 1), { ctrlKey: true })
	expect(app.state.text).toBe('ba')
	// Alt-Backspace deletes a whitespace word, past the punctuation.
	expect(press('Backspace', box('cat src/a.ts', 12), { altKey: true })).toBe(true)
	expect(app.state.text).toBe('cat ')
	// Alt-Left crosses a blank line (Chrome's native one sticks), and
	// Shift extends the selection.
	edits.length = 0
	expect(press('ArrowLeft', box('a b\n\nc', 5), { altKey: true })).toBe(true)
	expect(edits).toEqual([[{ start: 6, end: 6, text: '' }, 2]])
	press(
		'ArrowLeft',
		{ kind: 'message', text: 'a b', cursor: 3, write: (...a) => void edits.push(a) },
		{ altKey: true, shiftKey: true },
	)
	expect(edits[1]).toEqual([{ start: 3, end: 3, text: '' }, 2, 3])
})

test('Tab and Shift-Tab indent a selection that spans lines; otherwise they move focus', () => {
	app.onEvent(snapshot({ type: 'idle' }))
	let edits: unknown[] = []
	let box = (text: string, cursor: number, anchor?: number): Target => ({
		kind: 'message',
		text,
		cursor,
		anchor,
		write: (...a) => void edits.push(a),
	})
	expect(press('Tab', box('one two', 2))).toBe(false)
	expect(press('Tab', box('one two', 2, 5))).toBe(false)
	expect(press('Tab', box('one\ntwo', 0), { shiftKey: true })).toBe(false)
	expect(edits).toEqual([])
	// The selection grows to take in the first line's tab, as a native edit.
	expect(press('Tab', box('one\ntwo', 6, 1))).toBe(true)
	expect(app.state.text).toBe('\tone\n\ttwo')
	expect(edits).toEqual([[{ start: 0, end: 4, text: '\tone\n\t' }, 8, 0]])
	expect(press('Tab', box('\tone\n\ttwo', 8, 0), { shiftKey: true })).toBe(true)
	expect(app.state.text).toBe('one\ntwo')
	expect(edits[1]).toEqual([{ start: 0, end: 6, text: 'one\n' }, 6, 0])
	// In a later line's leading whitespace Tab indents; after text it moves focus.
	expect(press('Tab', box('f() {\n', 6))).toBe(true)
	expect(app.state.text).toBe('f() {\n\t')
	expect(press('Tab', box('f() {\n\tx', 8))).toBe(false)
	expect(press('Tab', box('f() {\nx', 6), { shiftKey: true })).toBe(false)
})

test('Ctrl-Y replaces the selection in the box', () => {
	app.onEvent(snapshot({ type: 'idle' }))
	press('k', { kind: 'message', text: 'ab', cursor: 1 }, { ctrlKey: true })
	let edits: unknown[] = []
	press(
		'y',
		{ kind: 'message', text: 'a', cursor: 0, anchor: 1, write: (...a) => void edits.push(a) },
		{ ctrlKey: true },
	)
	expect(app.state.text).toBe('b')
	expect(edits).toEqual([[{ start: 0, end: 1, text: 'b' }, 1, 1]])
})

test('keys the browser already handles stay native in the box', () => {
	app.onEvent(snapshot({ type: 'idle' }))
	for (let [key, mods] of [
		['ArrowRight', { altKey: true }],
		['Backspace', {}],
		['a', { ctrlKey: true }],
		['e', { ctrlKey: true }],
		['z', { metaKey: true }],
	] as const)
		expect(press(key, message('hello world', 5), mods)).toBe(false)
	expect(app.state.text).toBe('hello world')
})
