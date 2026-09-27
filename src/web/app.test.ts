import { afterEach, beforeEach, expect, test } from 'bun:test'
import { connection } from '../common/connection.ts'
import { drafts, type Local } from '../common/drafts.ts'
import type { Event } from '../common/protocol.ts'
import { app, type Target } from './app.ts'

const meta = { id: '1-abc', cwd: '/w', model: 'fake/m', createdAt: '2026-09-26T00:00:00Z' }
const sessionId = meta.id
const ts = '2026-09-26T00:00:01Z'

let sent: any[] = []
let stored = new Map<string, Local>()
let redraws = 0
const orig = { send: connection.send, connected: connection.connected, store: drafts.store }

beforeEach(() => {
	sent = []
	stored = new Map()
	redraws = 0
	app.reset()
	drafts.reset()
	connection.send = (c: any) => void sent.push(c)
	connection.connected = () => true
	drafts.store = { load: (id) => stored.get(id), save: (id, l) => void stored.set(id, structuredClone(l)) }
	app.changed = () => void redraws++
})

afterEach(() => {
	connection.send = orig.send
	connection.connected = orig.connected
	drafts.store = orig.store
	drafts.reset()
	app.reset()
})

const press = (key: string, target: Target, mods: Partial<Record<'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey', boolean>> = {}) =>
	app.key({ key, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...mods }, target)
const message = (text: string, caretAtEnd = true): Target => ({ kind: 'message', text, caretAtEnd })
const snapshot = (state: object, history: object[] = [], draft?: object): Event =>
	({ type: 'snapshot', sessionId, snapshot: { meta, history, state, ...(draft ? { draft } : {}) } }) as Event

test('Enter sends the message box as a prompt: it shows pending and the box empties', () => {
	app.onEvent(snapshot({ type: 'idle' }))
	// Text put in the box without an input event is what gets sent.
	expect(press('Enter', message('hi'))).toBe(true)
	expect(sent.find((c) => c.type === 'submit')).toMatchObject({ sessionId, text: 'hi' })
	expect(app.pending()).toEqual(['hi'])
	expect(app.state.text).toBe('')
	expect(redraws).toBeGreaterThan(0)
	// Acknowledged, it is no longer pending.
	let id = sent.find((c) => c.type === 'submit').id
	app.onEvent({ type: 'ack', id } as Event)
	expect(app.pending()).toEqual([])
})

test('Shift+Enter is a newline; Enter before a session exists keeps the text with a notice', () => {
	expect(press('Enter', message('hi'), { shiftKey: true })).toBe(false)
	expect(press('Enter', message('hi'))).toBe(true)
	expect(app.state.text).toBe('hi')
	expect(app.notice()).toBeTruthy()
	expect(sent.filter((c) => c.type === 'submit')).toEqual([])
})

test('typing is the session draft, and a snapshot brings the kept draft back', () => {
	app.onEvent(snapshot({ type: 'idle' }, [], { text: 'from host', rev: 3 }))
	expect(app.state.text).toBe('from host')
	app.input('mine')
	expect(stored.get(sessionId)?.text).toBe('mine')
	expect(sent.some((c) => c.type === 'draft' && c.text === 'mine')).toBe(true)
})

test('Up on an empty box while the model works edits the last prompt; Down unchanged leaves', () => {
	app.onEvent(snapshot({ type: 'running', phase: 'streaming' }, [{ type: 'user', blocks: [{ type: 'text', text: 'fix ti' }], ts }]))
	expect(press('ArrowUp', message('draft'))).toBe(false)
	expect(press('ArrowUp', message(''))).toBe(true)
	expect(app.state.text).toBe('fix ti')
	expect(sent.at(-1)).toMatchObject({ type: 'pause', sessionId })
	expect(app.state.view.editing).toBeDefined()
	expect(press('ArrowDown', message('fix ti'))).toBe(true)
	expect(app.state.text).toBe('')
	expect(app.state.view.editing).toBeUndefined()
})

test('Tab at the end of a slash command asks the host, and its answer fills the box', () => {
	app.onEvent(snapshot({ type: 'idle' }))
	expect(press('Tab', message('/cd ~/p', false))).toBe(false)
	expect(press('Tab', message('/cd ~/p'))).toBe(true)
	expect(sent.at(-1)).toMatchObject({ type: 'complete', sessionId, text: '/cd ~/p' })
	app.onEvent({ type: 'completions', sessionId, text: '/cd ~/p', items: ['/cd ~/projects/'] })
	expect(app.state.text).toBe('/cd ~/projects/')
})

test('an open question takes the keys: fields type natively, Enter answers', () => {
	let form = { text: 'Name?', fields: [{ type: 'text' as const, name: 'name' }] }
	app.onEvent(snapshot({ type: 'blocked', reason: 'question' }))
	app.onEvent({ type: 'question', sessionId, id: 'q1', form })
	expect(press('a', { kind: 'field' })).toBe(false)
	app.formInput(0, 'Ann')
	expect(press('Enter', { kind: 'field' })).toBe(true)
	expect(sent.at(-1)).toMatchObject({ type: 'answer', sessionId, question: 'q1', answers: { name: 'Ann' } })
})

test('a click on an option of a one-field question answers it', () => {
	let form = { text: 'Ok?', fields: [{ type: 'choice' as const, name: 'ok', options: ['yes', 'no'] }] }
	app.onEvent(snapshot({ type: 'blocked', reason: 'question' }))
	app.onEvent({ type: 'question', sessionId, id: 'q1', form })
	app.pick(0, 'no')
	expect(sent.at(-1)).toMatchObject({ type: 'answer', question: 'q1', answers: { ok: 'no' } })
})

test('answering while disconnected sends nothing and says so', () => {
	let form = { text: 'Ok?', fields: [{ type: 'choice' as const, name: 'ok', options: ['yes', 'no'] }] }
	app.onEvent(snapshot({ type: 'blocked', reason: 'question' }))
	app.onEvent({ type: 'question', sessionId, id: 'q1', form })
	connection.connected = () => false
	app.pick(0, 'yes')
	expect(sent.filter((c) => c.type === 'answer')).toEqual([])
	expect(app.notice()).toMatch(/not connected/)
})

test('Ctrl-M asks for models; the picker takes the keys and a click picks', () => {
	app.onEvent(snapshot({ type: 'idle' }))
	expect(press('m', message(''), { ctrlKey: true })).toBe(true)
	expect(sent.at(-1)).toMatchObject({ type: 'models', sessionId })
	app.onEvent({ type: 'models', sessionId, current: 'fake/m', items: ['fake/m', 'x/y'] })
	expect(app.state.view.modal).toBeDefined()
	// Plain keys go to the search box.
	expect(press('x', { kind: 'other' })).toBe(false)
	app.modalPick(1)
	expect(sent.at(-1)).toMatchObject({ type: 'submit', text: '/model x/y' })
	expect(app.state.view.modal).toBeUndefined()
})

test('the link state shows as a notice until connected', () => {
	app.onState({ type: 'disconnected', retryAt: 0 })
	expect(app.notice()).toMatch(/reconnect/)
	app.onState({ type: 'connected', role: 'client' })
	expect(app.notice()).toBeUndefined()
})
