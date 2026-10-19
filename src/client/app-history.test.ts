// App tests for browsing sent prompts with Up and Down.

import { expect, test } from 'bun:test'
import { drafts } from '../common/drafts.ts'
import type { Event } from '../common/protocol.ts'
import { app } from './app.ts'
import { appView } from './app-view.ts'
import {
	useApp,
	sent,
	drafted,
	snapshot,
	key,
	type,
	enter,
	up,
	down,
	ctrl,
	startOn,
	sentBefore,
} from './app-fixture.test.ts'

useApp()

test('Up and Down browse the prompts sent; the draft stays the text being written', () => {
	sentBefore('first', 'second')
	type('mine')
	drafted.length = 0
	up()
	expect(appView.view().prompt).toMatchObject({ text: 'second', cursor: 6 })
	up()
	expect(appView.view().prompt.text).toBe('first')
	// The oldest: Up goes to the start.
	up()
	expect(appView.view().prompt).toMatchObject({ text: 'first', cursor: 0 })
	down()
	expect(appView.view().prompt.text).toBe('second')
	expect(drafts.text('s1')).toBe('mine')
	down()
	expect(appView.view().prompt).toMatchObject({ text: 'mine', cursor: 4 })
	expect(drafted).toEqual([])
})

test('an edited entry becomes the draft; sending an entry brings the own text back', () => {
	sentBefore('first')
	type('mine')
	up()
	type('!')
	expect(drafts.text('s1')).toBe('first!')
	// Past the newest entry, Down restores the edited draft.
	down()
	expect(appView.view().prompt.text).toBe('first!')
	app.onKeys([
		key('backspace'),
		key('backspace'),
		key('backspace'),
		key('backspace'),
		key('backspace'),
		key('backspace'),
	])
	type('mine')
	up()
	enter()
	expect(sent.at(-1)).toEqual({ type: 'submit', sessionId: 's1', text: 'first' })
	expect(appView.view().prompt.text).toBe('mine')
	expect(drafts.text('s1')).toBe('mine')
})

test('a draft from elsewhere does not replace a recalled entry but is what Down brings back', () => {
	sentBefore('first')
	up()
	app.onEvent({ type: 'draft', sessionId: 's1', draft: { text: 'web text', rev: 3 } })
	expect(appView.view().prompt.text).toBe('first')
	down()
	expect(appView.view().prompt.text).toBe('web text')
})

test('the last prompt being edited is skipped by the first Up', () => {
	app.onEvent({
		type: 'snapshot',
		sessionId: 's1',
		snapshot: {
			meta: { id: 's1', cwd: '/', model: 'anthropic/x', createdAt: '' },
			state: { type: 'running', phase: 'streaming' },
			history: [
				{ type: 'user', blocks: [{ type: 'text', text: 'one' }], n: 1, ts: '' },
				{ type: 'user', blocks: [{ type: 'text', text: 'two' }], n: 2, ts: '' },
			],
		},
	})
	up()
	expect(appView.view().prompt.text).toBe('two')
	up()
	expect(appView.view().prompt.text).toBe('one')
})

test('Up inside a multi-row prompt moves a row before recalling', () => {
	sentBefore('first')
	type('a')
	app.onKeys([{ ...key('enter'), shift: true }])
	type('b')
	up()
	expect(appView.view().prompt).toMatchObject({ text: 'a\nb', cursor: 1 })
	up()
	expect(appView.view().prompt.text).toBe('first')
})

test('browsing belongs to the tab: switching away and back keeps the recalled entry', () => {
	startOn(['a', 'b'])
	app.onEvent({ type: 'turn-start', sessionId: 'a', prompt: 'first', provider: 'anthropic' })
	app.onEvent({ type: 'state', sessionId: 'a', state: { type: 'idle' } })
	type('mine')
	up()
	app.onKeys([ctrl('n')])
	app.onEvent(snapshot('b'))
	app.onKeys([ctrl('p')])
	let again = snapshot('a') as Event & { type: 'snapshot' }
	again.snapshot.history = [{ type: 'user', blocks: [{ type: 'text', text: 'first' }], ts: '' }]
	app.onEvent(again)
	expect(appView.view().prompt.text).toBe('first')
	down()
	expect(appView.view().prompt.text).toBe('mine')
})
