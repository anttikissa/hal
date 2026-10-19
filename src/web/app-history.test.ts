// History in the web client: browsing earlier prompts with the arrows,
// and fetching earlier transcript pages while scrolling up.

import { expect, test } from 'bun:test'
import { drafts } from '../common/drafts.ts'
import type { Event } from '../common/protocol.ts'
import { app } from './app.ts'
import type { Target } from './keys.ts'
import { useApp, fx, message, meta, press, sessionId, snapshot, ts } from './app-fixture.test.ts'

useApp()

test('arrows inside a draft stay native; its first row starts history browsing until Down restores it', () => {
	let user = (text: string) => ({ type: 'user', blocks: [{ type: 'text', text }], ts })
	app.onEvent(snapshot({ type: 'idle' }, [user('first'), user('two\nlines')]))
	let writes: [string, number][] = []
	let box = (text: string, cursor = text.length, anchor?: number): Target => ({
		kind: 'message',
		text,
		cursor,
		anchor,
		write: (edit, at) => void writes.push([text.slice(0, edit.start) + edit.text + text.slice(edit.end), at]),
	})
	app.input('mine\nx')
	// Rows inside a draft move natively, explicit or soft-wrapped.
	expect(press('ArrowUp', box('mine\nx'))).toBe(false)
	expect(press('ArrowDown', box('mine\nx', 2))).toBe(false)
	let wrapped = 'words '.repeat(40)
	expect(press('ArrowUp', { ...box(wrapped, 100), top: false } as Target)).toBe(false)
	expect(press('ArrowDown', { ...box(wrapped, 100), bottom: false } as Target)).toBe(false)
	expect(press('ArrowUp', box('mine\nx', 0, 4))).toBe(false)
	expect(writes).toEqual([])
	expect(press('ArrowUp', box('mine\nx', 2))).toBe(true)
	expect(writes.at(-1)).toEqual(['two\nlines', 9])
	expect(press('ArrowDown', box('two\nlines'))).toBe(true)
	expect(writes.at(-1)?.[0]).toBe('mine\nx')
	app.input('')
	expect(press('ArrowUp', box(''))).toBe(true)
	expect(writes.at(-1)).toEqual(['two\nlines', 9])
	expect(app.state.text).toBe('two\nlines')
	expect(fx.stored.get(sessionId)?.text).toBe('')
	expect(press('ArrowUp', box('two\nlines', 3))).toBe(true)
	expect(writes.at(-1)).toEqual(['first', 5])
	// The oldest: native Up goes to the start.
	expect(press('ArrowUp', box('first'))).toBe(false)
	expect(press('ArrowDown', box('first'))).toBe(true)
	expect(writes.at(-1)).toEqual(['two\nlines', 3])
	expect(press('ArrowDown', box('two\nlines', 3))).toBe(false)
	expect(press('ArrowDown', box('two\nlines'))).toBe(true)
	expect(writes.at(-1)).toEqual(['', 0])
	expect(app.state.text).toBe('')
})

test('an edited entry becomes the draft; sending an entry brings the own text back', () => {
	app.onEvent(snapshot({ type: 'idle' }, [{ type: 'user', blocks: [{ type: 'text', text: 'first' }], ts }]))
	app.input('')
	press('ArrowUp', message(''))
	expect(app.state.text).toBe('first')
	app.input('first!')
	expect(fx.stored.get(sessionId)?.text).toBe('first!')
	expect(press('ArrowDown', message('first!'))).toBe(true)
	app.input('')
	press('ArrowUp', message(''))
	// A draft received underneath browsing is not replaced by recall.
	drafts.edit(sessionId, 'mine')
	press('Enter', message('first'))
	expect(fx.sent.findLast((c) => c.type === 'submit')).toMatchObject({ text: 'first' })
	expect(app.state.text).toBe('mine')
	expect(fx.stored.get(sessionId)?.text).toBe('mine')
})

test('scrolling near the top fetches the page before; it goes in front', () => {
	let turn = (n: number) => [
		{ type: 'user', blocks: [{ type: 'text', text: `p${n}` }], ts },
		{ type: 'assistant', block: { type: 'text', text: `a${n}` }, ts },
		{ type: 'turn_end', status: 'completed', usage: {}, ts },
	]
	let open = { type: 'question', id: 'q', form: { text: 'Ok?', fields: [{ type: 'text', name: 'x' }] }, ts }
	// The tail is turn 3; the open question and the last prompt are further back.
	app.onEvent({
		type: 'snapshot',
		sessionId,
		snapshot: { meta, history: [...turn(3)], state: { type: 'idle' }, older: 200, earlier: [] },
	} as Event)
	app.older()
	app.older()
	expect(fx.sent.filter((c) => c.type === 'history')).toEqual([expect.objectContaining({ sessionId, before: 200 })])
	// A page for a spot nobody asked for is ignored.
	app.onEvent({ type: 'history', sessionId, before: 999, records: turn(9) } as Event)
	expect(app.state.pages).toBe(0)
	app.onEvent({ type: 'history', sessionId, before: 200, records: turn(2), older: 100 } as Event)
	expect(app.state.pages).toBe(1)
	expect(app.state.view.transcript!.items.map((i: any) => i.text ?? i.type)).toEqual([
		'p2',
		'a2',
		'turn-end',
		'p3',
		'a3',
		'turn-end',
	])
	app.older()
	app.onEvent({ type: 'history', sessionId, before: 100, records: [...turn(1), open] } as Event)
	expect(app.state.view.transcript!.items.map((i: any) => i.text ?? i.type).slice(0, 4)).toEqual([
		'p1',
		'a1',
		'turn-end',
		'question',
	])
	fx.sent = []
	app.older()
	expect(fx.sent).toEqual([])
})

for (let restore of ['delete', 'undo'])
	test(`history continues after a recalled entry is edited and restored by ${restore}`, () => {
		let user = (text: string) => ({ type: 'user', blocks: [{ type: 'text', text }], ts })
		app.onEvent(snapshot({ type: 'idle' }, [user('first'), user('second'), user('third')]))
		press('ArrowUp', message(''))
		press('ArrowUp', message('third'))
		expect(app.state.text).toBe('second')
		app.input('second!')
		// Native deletion and native undo both report restored text via input.
		if (restore === 'undo') expect(press('z', message('second!'), { metaKey: true })).toBe(false)
		app.input('second')
		expect(press('ArrowUp', message('second'))).toBe(true)
		expect(app.state.text).toBe('first')
		press('ArrowDown', message('first'))
		press('ArrowDown', message('second'))
		press('ArrowDown', message('third'))
		expect(app.state.text).toBe('second')
		expect(fx.stored.get(sessionId)?.text).toBe('second')
	})
