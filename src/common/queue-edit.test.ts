import { afterEach, beforeEach, expect, test } from 'bun:test'
import { connection } from './connection.ts'
import { drafts, type Local } from './drafts.ts'
import { queueEdit } from './queue-edit.ts'
import { transcript } from './transcript.ts'

let sent: any[] = []
let stored = new Map<string, Local>()
let connected = true
const original = { send: connection.send, connected: connection.connected, store: drafts.store }
const ts = '2026-10-04T20:13:07.456Z'
const t = () => transcript.fromSnapshot({ meta: { id: 's1', cwd: '/tmp', model: 'fake/m', createdAt: ts }, history: [], state: { type: 'paused' }, inbox: [
	{ id: 'q1', text: 'older', queue: true, ts },
	{ id: 'peer', text: 'not mine', queue: true, from: 'other', ts },
	{ id: 'q2', text: 'newer', queue: true, ts },
	{ id: 'steer', text: 'steering', ts },
] })
const reply = (text = 'newer') => { let e = queueEdit.current('s1')!; queueEdit.onEvent({ type: 'queue-edit', sessionId: 's1', edit: e.edit, message: e.message, text }) }

beforeEach(() => {
	sent = []; stored = new Map(); connected = true
	drafts.reset(); queueEdit.disconnected()
	connection.send = (c) => { sent.push(c) }
	connection.connected = () => connected
	drafts.store = { load: (id) => stored.get(id), save: (id, local) => { stored.set(id, structuredClone(local)) } }
})
afterEach(() => { connection.send = original.send; connection.connected = original.connected; drafts.store = original.store; drafts.reset(); queueEdit.disconnected() })

test('selects newest human queue item and waits for host protection before exposing or saving it', () => {
	expect(queueEdit.candidate(t())?.id).toBe('q2')
	drafts.edit('s1', 'pre-existing draft')
	queueEdit.begin(t(), 'q2')
	expect(queueEdit.editing('s1')).toBeUndefined()
	expect(queueEdit.text('s1')).toBe('pre-existing draft')
	expect(queueEdit.input('s1', 'typing while acquisition is pending')).toBe(false)
	expect(queueEdit.save('s1')).toContain('not protected')
	expect(sent.some((c) => c.type === 'submit')).toBe(false)
	reply('authoritative newer text')
	expect(queueEdit.editing('s1')).toMatchObject({ inbox: 'q2', original: 'authoritative newer text', aside: true })
	queueEdit.input('s1', 'corrected')
	queueEdit.save('s1')
	let submit = sent.find((c) => c.type === 'submit')
	expect(submit).toMatchObject({ text: 'corrected', edits: 'q2', amend: true, queueEdit: queueEdit.current('s1')!.edit })
	expect(drafts.text('s1')).toBe('pre-existing draft')
	expect(drafts.pending('s1')).toEqual([])
	queueEdit.onEvent({ type: 'ack', id: submit.id })
	drafts.onEvent({ type: 'ack', id: submit.id })
	expect(queueEdit.current('s1')).toBeUndefined()
	expect(queueEdit.text('s1')).toBe('pre-existing draft')
})

test('cancel preserves changed edit separately, and re-edit restores it without changing the ordinary draft', () => {
	drafts.edit('s1', 'my draft')
	queueEdit.begin(t(), 'q2'); reply()
	queueEdit.input('s1', 'unsaved corrections')
	expect(queueEdit.cancel('s1')).toContain('unsaved changes')
	expect(queueEdit.text('s1')).toBe('my draft')
	expect(queueEdit.current('s1')).toMatchObject({ active: false, text: 'unsaved corrections' })
	queueEdit.begin(t(), 'q2'); reply()
	expect(queueEdit.text('s1')).toBe('unsaved corrections')
	expect(drafts.text('s1')).toBe('my draft')
})

test('reloaded edits reacquire before pending save replay and keep exact unsent text', () => {
	drafts.edit('s1', 'my draft')
	queueEdit.begin(t(), 'q2'); reply(); queueEdit.input('s1', 'corrected'); queueEdit.save('s1')
	let originalSubmit = sent.find((c) => c.type === 'submit')
	drafts.reset(); queueEdit.disconnected(); sent = []
	let snapshot = { type: 'snapshot' as const, sessionId: 's1', snapshot: { meta: t().meta, history: [], state: { type: 'paused' as const }, inbox: t().inbox, draft: { text: 'my draft', rev: 1 } } }
	queueEdit.onEvent(snapshot)
	drafts.onEvent(snapshot)
	expect(sent.slice(0, 2).map((c) => c.type)).toEqual(['queue-edit', 'submit'])
	expect(sent[1]).toEqual(originalSubmit)
	expect(queueEdit.ready('s1')).toBe(false)
	expect(queueEdit.text('s1')).toBe('corrected')
	expect(queueEdit.editing('s1')).toMatchObject({ original: 'newer' })
	reply()
	expect(queueEdit.text('s1')).toBe('corrected')
})

test('failed reacquisition restores changed text without losing the draft or hiding the rejection', () => {
	drafts.edit('s1', 'my draft')
	queueEdit.begin(t(), 'q2'); reply(); queueEdit.input('s1', 'corrected')
	queueEdit.acquire('s1')
	let request = queueEdit.current('s1')!.request!
	queueEdit.onEvent({ type: 'rejected', sessionId: 's1', id: request, command: 'queue-edit', reason: 'already delivered' })
	expect(queueEdit.current('s1')).toBeUndefined()
	expect(drafts.text('s1')).toBe('my draft\n\ncorrected')
	expect(stored.get('s1')!.text).toBe('my draft\n\ncorrected')
})


test('a changed queued message after reconnect never silently overwrites another edit', () => {
	drafts.edit('s1', 'my draft')
	queueEdit.begin(t(), 'q2'); reply(); queueEdit.input('s1', 'my correction')
	queueEdit.disconnected(); queueEdit.acquire('s1')
	let e = queueEdit.current('s1')!
	let out = queueEdit.onEvent({ type: 'queue-edit', sessionId: 's1', edit: e.edit, message: e.message, text: 'changed by another client' })
	expect(out?.notice).toContain('rather than overwriting')
	expect(queueEdit.current('s1')).toBeUndefined()
	expect(drafts.text('s1')).toBe('my draft\n\nmy correction')
	expect(sent.at(-1).type).toBe('queue-edit-cancel')
	expect(sent.some((c) => c.type === 'submit')).toBe(false)
})
