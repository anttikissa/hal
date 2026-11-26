// A prompt card's Edit (task 26q): the draft is set aside while editing
// and comes back on cancel and after sending; a working turn is paused
// at the start and continued on cancel.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { amend } from '../common/amend.ts'
import { connection } from '../common/connection.ts'
import { drafts, type Local } from '../common/drafts.ts'
import type { Event } from '../common/protocol.ts'
import { app } from './app.ts'
import { editPrompt } from './edit-prompt.ts'
import { keys } from './keys.ts'
import { recall } from '../common/recall.ts'

const meta = { id: '1-abc', cwd: '/w', model: 'fake/m', createdAt: '2026-09-26T00:00:00Z' }
const sessionId = meta.id
const ts = '2026-09-26T00:00:01Z'
let sent: any[] = []
let stored = new Map<string, Local>()
const orig = { send: connection.send, connected: connection.connected, store: drafts.store }

beforeEach(() => {
	sent = []
	stored = new Map()
	app.reset()
	drafts.reset()
	connection.send = (c: any) => void sent.push(c)
	connection.connected = () => true
	drafts.store = { load: (id) => stored.get(id), save: (id, l) => void stored.set(id, structuredClone(l)) }
	app.changed = () => {}
})

afterEach(() => {
	Object.assign(connection, { send: orig.send, connected: orig.connected })
	drafts.store = orig.store
	drafts.reset()
	app.reset()
})

// Two turns: prompt #1 'one' (a bash call), prompt #5 'two'.
const history = [
	{ type: 'user', blocks: [{ type: 'text', text: 'one' }], n: 1, ts },
	{ type: 'assistant', block: { type: 'tool_call', id: 't1', name: 'bash', input: { command: 'touch x' } }, n: 2, ts },
	{ type: 'user', blocks: [{ type: 'tool_result', id: 't1', output: '' }], n: 3, ts },
	{ type: 'turn_end', status: 'completed', usage: {}, n: 4, ts },
	{ type: 'user', blocks: [{ type: 'text', text: 'two' }], n: 5, ts },
	{ type: 'assistant', block: { type: 'text', text: 'ok' }, n: 6, ts },
]
const open = (state: object) =>
	app.onEvent({ type: 'snapshot', sessionId, snapshot: { meta, history, state } } as Event)
const escape = () =>
	keys.key({ key: 'Escape', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false }, { kind: 'other' })

test('Up right after sending a slash command, while working, shows it and leaves the turn running', () => {
	open({ type: 'running', phase: 'streaming' })
	app.input('/help foo')
	app.send()
	let shown = ''
	let up = () =>
		keys.key({ key: 'ArrowUp', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false }, {
			kind: 'message',
			text: '',
			cursor: 0,
			write: (s: { text: string }) => void (shown = s.text),
		} as any)
	up()
	expect(sent.filter((c) => c.type === 'pause')).toEqual([])
	expect(shown).toBe('/help foo')
	app.onEvent({ type: 'command', sessionId, text: '/help foo' } as Event)
	drafts.reset()
	recall.reset()
	up()
	expect(sent.filter((c) => c.type === 'pause')).toEqual([])
	expect(shown).toBe('/help foo')
})

test('editing an earlier prompt pauses, keeps the draft; Escape warns on unsaved changes while Cancel keeps them', () => {
	open({ type: 'running', phase: 'streaming' })
	app.input('my draft')
	expect(editPrompt.edit('1')).toBe(true)
	expect(sent.at(-1)).toEqual({ type: 'pause', sessionId })
	expect(app.state.text).toBe('one')
	expect(app.state.view.editing).toMatchObject({ rewind: 1, later: 3, changed: true })
	app.input('uno')
	expect(drafts.text(sessionId)).toBe('my draft')
	// Escape does not discard unsaved changes: shows a notice and stays in amend mode.
	expect(escape()).toBe(true)
	expect(app.state.view.editing).toBeDefined()
	expect(app.state.view.notice).toBe(amend.unsavedNotice)
	expect(app.state.text).toBe('uno')
	// Clicking Cancel leaves amend mode, restores the draft, continues, and keeps the unsent edit.
	expect(editPrompt.leave()).toBe(true)
	expect(sent.at(-1)).toEqual({ type: 'continue', sessionId })
	expect(app.state.text).toBe('my draft')
	expect(app.state.view.editing).toBeUndefined()
	expect(app.state.view.notice).toBe(amend.canceledNotice)
	// Reopening the prompt restores the saved edit.
	expect(editPrompt.edit('1')).toBe(true)
	expect(app.state.text).toBe('uno')
})

test('amend Up/Down preserves edits per slot, writes through undo-safe target.write, stops held Up repeat, and survives reload', () => {
	open({ type: 'running', phase: 'streaming' })
	app.input('bottom draft')
	let writes: string[] = []
	let box = (text: string, cursor = 0) => ({
		kind: 'message' as const,
		text,
		cursor,
		write: (edit: { start: number; end: number; text: string }) =>
			void writes.push(text.slice(0, edit.start) + edit.text + text.slice(edit.end)),
	})
	let press = (key: string, text: string, cursor = 0, repeat = false) =>
		keys.key({ key, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, repeat }, box(text, cursor))
	// Held ArrowUp repeat stops at line 1 without entering amend.
	expect(press('ArrowUp', 'bottom draft', 0, true)).toBe(false)
	expect(app.state.view.editing).toBeUndefined()
	// Deliberate ArrowUp opens prompt #5 in amend mode via undo-preserving write.
	expect(press('ArrowUp', 'bottom draft', 0)).toBe(true)
	expect(app.state.text).toBe('two')
	expect(writes.at(-1)).toBe('two')
	// Expand to a long paragraph; held ArrowUp does not step away.
	let long = 'x'.repeat(541)
	app.input(long)
	expect(press('ArrowUp', long, 0, true)).toBe(false)
	expect(app.state.text).toBe(long)
	// Deliberate ArrowUp steps to prompt #1 while saving #5; ArrowDown brings #5 back intact.
	expect(press('ArrowUp', long, 0)).toBe(true)
	expect(app.state.text).toBe('one')
	expect(writes.at(-1)).toBe('one')
	expect(press('ArrowDown', 'one', 3)).toBe(true)
	expect(app.state.text).toBe(long)
	expect(writes.at(-1)).toBe(long)
	// Reload while editing restores active amend and the 541-char text.
	app.reset()
	drafts.reset()
	open({ type: 'paused' })
	expect(app.state.view.editing?.target).toBe('5')
	expect(app.state.text).toBe(long)
	// ArrowDown past the newest prompt leaves amend, continues the turn, restores draft, and keeps #5 saved.
	expect(press('ArrowDown', long, long.length)).toBe(true)
	expect(app.state.view.editing).toBeUndefined()
	expect(app.state.text).toBe('bottom draft')
	expect(sent.at(-1)).toEqual({ type: 'continue', sessionId })
	// Even if the turn finishes (idle), ArrowUp recalls #5 with the saved 541-char text.
	app.onEvent({ type: 'state', sessionId, state: { type: 'idle' } })
	expect(press('ArrowUp', 'bottom draft', 0)).toBe(true)
	expect(app.state.text).toBe(long)
})

test('sending the edit rewinds there, and the draft comes back; an emptied edit cancels', () => {
	open({ type: 'idle' })
	app.input('my draft')
	editPrompt.edit('1')
	app.input('uno')
	app.send()
	expect(sent.filter((c) => c.type === 'submit')).toMatchObject([{ sessionId, text: 'uno' }])
	expect(sent.find((c) => c.type === 'submit').rewind).toBeUndefined()
	expect(app.state.text).toBe('my draft')
	// Idle at the start: nothing was paused, so nothing continues.
	editPrompt.edit('5')
	expect(app.state.view.editing?.rewind).toBeUndefined()
	app.input('')
	app.send()
	expect(sent.filter((c) => c.type === 'submit' || c.type === 'continue')).toHaveLength(1)
	expect(app.state.text).toBe('my draft')
})

test('queued card Edit preserves the draft and waits for protection; save and cancel do not use prompt rewind', () => {
	open({ type: 'running', phase: 'streaming' })
	app.onEvent({ type: 'inbox', sessionId, inbox: [{ id: 'queued', text: 'queued text', delivery: 'after-turn', ts }] })
	app.input('my draft')
	expect(editPrompt.edit('queued')).toBe(true)
	let acquire = sent.at(-1)
	expect(acquire).toMatchObject({ type: 'queue-edit', message: 'queued' })
	expect(app.state.text).toBe('my draft')
	expect(app.state.view.editing).toBeUndefined()
	app.onEvent({ type: 'queue-hold', sessionId, message: 'queued' })
	app.onEvent({ type: 'queue-edit', sessionId, edit: acquire.edit, message: 'queued', text: 'queued text' })
	expect(app.state.text).toBe('queued text')
	expect(app.state.view.editing).toMatchObject({ queueEdit: acquire.edit, aside: true })
	app.input('corrected queue')
	app.send('queue')
	let save = sent.at(-1)
	expect(save).toMatchObject({ type: 'submit', text: 'corrected queue', edits: 'queued', queueEdit: acquire.edit })
	expect(save.queue).toBeUndefined()
	expect(app.pending()).toEqual([])
	app.onEvent({ type: 'ack', id: save.id })
	app.onEvent({ type: 'queue-hold', sessionId })
	expect(app.state.text).toBe('my draft')
	expect(app.state.view.editing).toBeUndefined()
	editPrompt.edit('queued')
	acquire = sent.at(-1)
	app.onEvent({ type: 'queue-edit', sessionId, edit: acquire.edit, message: 'queued', text: 'corrected queue' })
	app.input('not saved yet')
	expect(escape()).toBe(true)
	expect(sent.at(-1)).toMatchObject({ type: 'queue-edit-cancel', edit: acquire.edit })
	expect(app.state.text).toBe('my draft')
	expect(stored.get(sessionId)!.queueEdit?.text).toBe('not saved yet')
})
