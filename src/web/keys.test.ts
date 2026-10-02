import { afterEach, beforeEach, expect, test } from 'bun:test'
import { connection } from '../common/connection.ts'
import { drafts } from '../common/drafts.ts'
import type { Event } from '../common/protocol.ts'
import { app } from './app.ts'
import { keys, type KeyInput, type Target } from './keys.ts'
import { restart } from './restart.ts'

const meta = { id: '1-abc', cwd: '/w', model: 'fake/m', createdAt: '2026-09-26T00:00:00Z' }
const sessionId = meta.id

let sent: any[] = []
let typed: string[] = []
const orig = { send: connection.send, connected: connection.connected, store: drafts.store, insert: keys.insert }

beforeEach(() => {
	sent = []
	typed = []
	app.reset()
	drafts.reset()
	connection.send = (c: any) => void sent.push(c)
	connection.connected = () => true
	drafts.store = { load: () => undefined, save: () => {} }
	keys.insert = (text) => void typed.push(text)
	app.onEvent({ type: 'snapshot', sessionId, snapshot: { meta, history: [], state: { type: 'idle' } } } as Event)
})

afterEach(() => {
	Object.assign(connection, { send: orig.send, connected: orig.connected })
	drafts.store = orig.store
	keys.insert = orig.insert
	drafts.reset()
	app.reset()
})

const press = (key: string, target: Target, mods: Partial<KeyInput> = {}) =>
	keys.key({ key, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...mods }, target)
const other: Target = { kind: 'other' }
const clip = (text: string) => ({ items: [], getData: (t: string) => (t === 'text/plain' ? text : '') })

test('on a touch keyboard Enter is a newline and the Send button sends', () => {
	let touch: Target = { kind: 'message', text: 'hi', cursor: 2, coarse: true }
	expect(press('Enter', touch)).toBe(false)
	expect(sent.some((c) => c.type === 'submit')).toBe(false)
	app.send()
	expect(sent.find((c) => c.type === 'submit')).toMatchObject({ text: 'hi' })
})

test('a printable key outside any field types into the box, keeping the key', () => {
	expect(press('h', other)).toBe(true)
	expect(press('H', other, { shiftKey: true })).toBe(true)
	expect(press('ä', { kind: 'button', submits: false })).toBe(true)
	expect(typed).toEqual(['h', 'H', 'ä'])
})

test('keys that do not type, fields, and Space on a button stay where they are', () => {
	for (let [key, mods] of [['a', { ctrlKey: true }], ['a', { metaKey: true }], ['ArrowDown', {}], ['Enter', {}], ['F5', {}]] as const) expect(press(key, other, mods)).toBe(false)
	expect(press('a', { kind: 'field' })).toBe(false)
	expect(press(' ', { kind: 'button', submits: false })).toBe(false)
	expect(press('a', other, { isComposing: true })).toBe(false)
	expect(typed).toEqual([])
})

test('with the model picker open, typing goes to its search box, not the message box', () => {
	app.setView({ ...app.state.view, modal: { items: ['a/b'], selected: 0, search: '' } as any })
	expect(press('a', other)).toBe(false)
	expect(keys.paste(clip('x'), other)).toBe(false)
	expect(typed).toEqual([])
})

test('a paste outside any field goes into the box; in a field it stays native', () => {
	expect(keys.paste(clip('pasted'), other)).toBe(true)
	expect(typed).toEqual(['pasted'])
	expect(keys.paste(clip('x'), { kind: 'field' })).toBe(false)
	expect(keys.paste(clip('x'), { kind: 'message', text: '', cursor: 0 })).toBe(false)
	expect(typed).toEqual(['pasted'])
})

test('Tab and link Enter stay native in a pending question, while input Enter answers', () => {
	app.onEvent({ type: 'snapshot', sessionId, snapshot: { meta, history: [], state: { type: 'blocked', reason: 'question' } } })
	app.onEvent({ type: 'question', sessionId, id: 'q', form: { text: 'Open https://example.com/', fields: [{ type: 'text', name: 'code' }] } })
	expect(app.state.view.form).toBeDefined()
	expect(press('Enter', { kind: 'link' })).toBe(false)
	expect(press('Tab', { kind: 'field' })).toBe(false)
	expect(press('Tab', { kind: 'link' }, { shiftKey: true })).toBe(false)
	expect(sent).toEqual([])
	app.formInput(0, 'answer')
	expect(press('Enter', { kind: 'field' })).toBe(true)
	expect(sent).toContainEqual({ type: 'answer', sessionId, question: 'q', answers: { code: 'answer' } })
})

test('Ctrl-R reloads only this page in every view and saves the composer draft first', () => {
	let original = restart.reload
	let reloaded: string[] = []
	restart.reload = () => { reloaded.push(drafts.text(sessionId)) }
	try {
		let target: Target = { kind: 'message', text: 'unsaved input', cursor: 13 }
		expect(press('r', target, { ctrlKey: true })).toBe(true)
		app.setView({ ...app.state.view, modal: { items: ['a/b'], selected: 0, search: '' } as any })
		expect(press('r', { kind: 'field' }, { ctrlKey: true })).toBe(true)
		app.setView({ ...app.state.view, modal: undefined })
		app.onEvent({ type: 'question', sessionId, id: 'q', form: { text: 'Answer?', fields: [{ type: 'text', name: 'answer' }] } })
		expect(press('r', { kind: 'field' }, { ctrlKey: true })).toBe(true)
		expect(reloaded).toEqual(['unsaved input', 'unsaved input', 'unsaved input'])
		expect(sent.filter((c) => c.type !== 'draft')).toEqual([])
		for (let mods of [{ metaKey: true }, { ctrlKey: true, altKey: true }]) expect(press('r', other, mods)).toBe(false)
		expect(press('R', other, { ctrlKey: true, shiftKey: true })).toBe(true)
		expect(reloaded).toHaveLength(4)
	} finally {
		restart.reload = original
	}
})
