// App tests for editing the last prompt while or after a turn runs, and the queued-message editor.

import { expect, test } from 'bun:test'
import { connection } from '../common/connection.ts'
import { drafts } from '../common/drafts.ts'
import type { SessionState } from '../common/states.ts'
import { app } from './app.ts'
import { appView } from './app-view.ts'
import {
	useApp,
	sent,
	record,
	snapshot,
	key,
	type,
	enter,
	escape,
	working,
	up,
	down,
	paused,
} from './app-fixture.test.ts'

useApp()

test('Up on an empty prompt while the model works pauses it and edits the last prompt; Enter sends the edit', () => {
	working()
	up()
	expect(sent).toEqual([{ type: 'pause', sessionId: 's1' }])
	expect(appView.view().prompt).toEqual({ text: 'fix ti', cursor: 6 })
	expect(appView.view().editing).toContain('[editing prompt]')
	paused()
	app.onKeys([key('backspace'), key('backspace'), key('i', 'i'), key('t', 't')])
	enter()
	expect(sent.at(-1)).toEqual({ type: 'submit', sessionId: 's1', text: '/edit 5\nfix it', aside: true })
	expect(appView.view().prompt.text).toBe('')
	// The edit is over: the next prompt is a new one.
	type('more')
	enter()
	expect(sent.at(-1)).toEqual({ type: 'submit', sessionId: 's1', text: 'more', base: 0 })
})

test('an edit not yet acknowledged is sent again as an edit by the next client', () => {
	let stored = new Map<string, any>()
	let store = drafts.store
	drafts.store = {
		load: (id) => stored.get(id) && structuredClone(stored.get(id)),
		save: (id, l) => void stored.set(id, structuredClone(l)),
	}
	try {
		working()
		up()
		paused()
		type('!')
		enter()
		// The client crashes before the ack; a new one connects.
		app.reset()
		sent.length = 0
		app.onEvent(snapshot('s1', { type: 'running', phase: 'requesting' }))
		expect(sent).toEqual([{ type: 'submit', sessionId: 's1', text: '/edit 5\nfix ti!', aside: true }])
	} finally {
		drafts.store = store
	}
})

test('Down with the text unchanged, or Escape, continues the paused turn', () => {
	working()
	up()
	paused()
	down()
	expect(sent.at(-1)).toEqual({ type: 'continue', sessionId: 's1' })
	expect(appView.view().prompt.text).toBe('')
	app.onEvent({ type: 'state', sessionId: 's1', state: { type: 'running', phase: 'streaming' } })
	sent.length = 0
	up()
	paused()
	type('!')
	// Changed: Down is no way out; Escape discards the edit.
	down()
	expect(sent).toEqual([{ type: 'pause', sessionId: 's1' }])
	escape()
	expect(sent.at(-1)).toEqual({ type: 'continue', sessionId: 's1' })
	expect(appView.view().prompt.text).toBe('')
	expect(appView.view().editing).toBeUndefined()
})

test('Up recalls an invalid slash command instead of amending the earlier running prompt', () => {
	for (let state of [{ type: 'running', phase: 'streaming' }, { type: 'paused' }, { type: 'idle' }] as SessionState[]) {
		app.reset()
		sent.length = 0
		app.onEvent(snapshot('s1', state))
		app.onEvent({ type: 'prompt', sessionId: 's1', texts: ['fix the bug'], n: 1 })
		app.onEvent({ type: 'command', sessionId: 's1', text: '/autoclose sdf', n: 2 })
		app.onEvent({ type: 'output', sessionId: 's1', text: 'usage: /autoclose [on|off]', error: true, n: 3 })
		up()
		expect(appView.view().prompt.text).toBe('/autoclose sdf')
		expect(appView.view().editing).toBeUndefined()
		expect(sent).toEqual([])
		app.onKeys([key('backspace'), key('backspace'), key('backspace')])
		type('on')
		enter()
		expect(sent.at(-1)).toMatchObject({ type: 'submit', sessionId: 's1', text: '/autoclose on' })
		expect(sent.at(-1)).not.toHaveProperty('amend')
	}
})

test('Up edits with text typed; the draft comes back after leaving or sending the edit', () => {
	working()
	type('x')
	up()
	expect(sent).toEqual([{ type: 'pause', sessionId: 's1' }])
	expect(appView.view().prompt.text).toBe('fix ti')
	paused()
	down()
	expect(appView.view().prompt.text).toBe('x')
	app.onEvent({ type: 'state', sessionId: 's1', state: { type: 'running', phase: 'streaming' } })
	up()
	paused()
	type('!')
	enter()
	expect(sent.at(-1)).toEqual({ type: 'submit', sessionId: 's1', text: '/edit 5\nfix ti!', aside: true })
	expect(appView.view().prompt.text).toBe('x')
})

test('Up opens a queued editor only after host protection, Alt-Enter saves in place and restores the draft', () => {
	let send = connection.send
	connection.send = record
	try {
		app.onEvent(snapshot('s1', { type: 'running', phase: 'streaming' }))
		app.onEvent({ type: 'inbox', sessionId: 's1', inbox: [{ id: 'q1', text: 'queued text', delivery: 'after-turn' }] })
		app.onKeys([key('up')])
		let acquire = sent.at(-1)
		expect(acquire).toMatchObject({ type: 'queue-edit', message: 'q1' })
		expect(app.state.prompt.text).toBe('')
		expect(app.state.editing).toBeUndefined()
		app.onEvent({ type: 'queue-hold', sessionId: 's1', message: 'q1' })
		app.onEvent({ type: 'queue-edit', sessionId: 's1', edit: acquire.edit, message: 'q1', text: 'queued text' })
		expect(app.state.prompt.text).toBe('queued text')
		expect(appView.view().editing).toContain('waiting message')
		app.onEvent({ type: 'draft', sessionId: 's1', draft: { text: 'a separate draft', rev: 1 } })
		expect(app.state.prompt.text).toBe('queued text')
		type('!')
		app.onKeys([{ ...key('enter'), alt: true }])
		let save = sent.at(-1)
		expect(save).toMatchObject({ type: 'submit', edits: 'q1', queueEdit: acquire.edit, text: 'queued text!' })
		expect(save.queue).toBeUndefined()
		app.onEvent({ type: 'ack', id: drafts.local('s1').queueEdit!.saving! })
		expect(app.state.editing).toBeUndefined()
		expect(app.state.prompt.text).toBe('a separate draft')
	} finally {
		connection.send = send
	}
})
