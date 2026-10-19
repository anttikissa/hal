// App tests for tabs: starting, opening, switching and per-tab state.

import { expect, test } from 'bun:test'
import { connection } from '../common/connection.ts'
import { drafts, type Local } from '../common/drafts.ts'
import { modals } from '../common/modals.ts'
import { placeholders } from '../common/placeholders.ts'
import { ansi } from './ansi.ts'
import { app } from './app.ts'
import { appView } from './app-view.ts'
import { frame } from './frame.ts'
import {
	useApp,
	sent,
	drafted,
	record,
	snapshot,
	key,
	type,
	enter,
	up,
	down,
	tabOf,
	tabsEvent,
	ctrl,
	alt,
	acked,
	startOn,
	shown,
	sentBefore,
} from './app-fixture.test.ts'

useApp()

test('after the focused paint, nearby tabs load in slices and switching uses their cached tails', async () => {
	startOn(['a', 'b', 'c', 'd'], 'c')
	// Starting does not hold up the focused snapshot for background work.
	expect(sent).toEqual([])
	await Bun.sleep(5)
	expect(sent).toEqual([{ type: 'open', sessionId: 'b' }])
	app.onEvent(snapshot('b'))
	await Bun.sleep(5)
	expect(sent.at(-1)).toEqual({ type: 'open', sessionId: 'd' })
	app.onEvent(snapshot('d'))
	await Bun.sleep(5)
	expect(sent.at(-1)).toEqual({ type: 'open', sessionId: 'a' })
	app.onEvent(snapshot('a'))
	app.onKeys([alt('2')])
	expect(shown()).toBe('b')
	expect(appView.view().transcript?.meta.id).toBe('b')
	expect(sent.filter((c) => c.type === 'open').map((c) => c.sessionId)).toEqual(['b', 'd', 'a'])
})

test('the example on an empty prompt comes from the Hal list when the host marks the tab hal', () => {
	startOn(['a', 'b'])
	expect(appView.view().placeholder?.text).toBe(placeholders.general[0])
	app.onEvent(tabsEvent(tabOf('a', { hal: true }), 'b'))
	expect(appView.view().placeholder?.text).toBe(placeholders.hal[0])
})

test('a saved draft shown on starting is not doubled; text typed before it follows it', () => {
	let store = drafts.store
	let stored = new Map<string, Local>([['a', { text: 'saved', base: 0, dirty: true, sending: [] }]])
	drafts.store = {
		load: (id) => stored.get(id) && structuredClone(stored.get(id)),
		save: (id, l) => void stored.set(id, structuredClone(l)),
	}
	try {
		app.onEvent(tabsEvent('a', 'b'))
		acked('a')
		app.onEvent(snapshot('a'))
		expect(appView.view().prompt.text).toBe('saved')
		app.reset()
		type('early')
		app.onEvent(tabsEvent('a', 'b'))
		acked('a')
		expect(appView.view().prompt.text).toBe('saved\nearly')
		app.onEvent(snapshot('a'))
		expect(appView.view().prompt.text).toBe('saved\nearly')
		expect(stored.get('a')?.text).toBe('saved\nearly')
	} finally {
		drafts.store = store
	}
})

test('connecting asks the host for the tab to show; its ack focuses and follows it', () => {
	app.state.start = { cwd: '/w', last: 'b' }
	app.onState({ type: 'connected', role: 'host' })
	// It also asks for a code for its web links.
	expect(sent).toEqual([
		{ type: 'tab-start', cwd: '/w', last: 'b', timezone: expect.any(String) },
		{ type: 'auth', link: true },
	])
	app.onEvent(tabsEvent('a', 'b'))
	expect(shown()).toBeUndefined()
	acked('b')
	expect(shown()).toBe('b')
	expect(sent.at(-1)).toEqual({ type: 'open', sessionId: 'b' })
	// A reconnect asks for the tab shown, in its own cwd.
	app.onState({ type: 'connected', role: 'client' })
	expect(sent.at(-2)).toEqual({ type: 'tab-start', cwd: '/b', last: 'b', timezone: expect.any(String) })
})

test('a remote client starts without a cwd (it names nothing there) and its status names the host', () => {
	app.state.start = { last: 'b' }
	app.onState({ type: 'connected', role: 'client' })
	expect(sent[0]).toEqual({ type: 'tab-start', last: 'b', timezone: expect.any(String) })
	startOn(['a'])
	let link = connection.state.link
	connection.state.link = { type: 'connected', role: 'client' }
	try {
		expect(appView.view().status?.role).toBe('peer')
		appView.state.remote = 'example.com'
		expect(appView.view().status?.role).toBe('example.com')
	} finally {
		connection.state.link = link
		appView.state.remote = undefined
	}
})

test('Ctrl-T opens a tab after the focused one and shows it once the host names it', () => {
	startOn(['a', 'b'])
	app.onKeys([ctrl('t')])
	expect(sent).toEqual([{ type: 'tab-new', cwd: '/a', after: 'a' }])
	// The list comes first: until the ack it could be anyone's new tab.
	app.onEvent(tabsEvent('a', 'n', 'b'))
	expect(shown()).toBe('a')
	acked('n')
	expect(shown()).toBe('n')
	expect(sent.slice(1)).toEqual([{ type: 'open', sessionId: 'n' }])
	// Closing it goes back to where it was opened from.
	app.onKeys([ctrl('w')])
	expect(sent.at(-1)).toEqual({ type: 'tab-close', sessionId: 'n' })
	app.onEvent(tabsEvent('a', 'b'))
	expect(shown()).toBe('a')
})

test('Ctrl-Shift-T reopens the last closed tab and shows it', () => {
	startOn(['a', 'b'])
	app.onKeys([ctrl('t', true)])
	expect(sent).toEqual([{ type: 'tab-resume' }])
	app.onEvent(tabsEvent('a', 'b', 'c'))
	acked('c')
	expect(shown()).toBe('c')
})

test("tabs opened or closed elsewhere don't move focus, unless the focused one closes", () => {
	startOn(['a', 'b', 'c'], 'b')
	app.onEvent(tabsEvent('x', 'a', 'b', 'c'))
	app.onEvent(tabsEvent('x', 'b', 'c'))
	expect(shown()).toBe('b')
	app.onEvent(tabsEvent('x', 'c'))
	expect(shown()).toBe('c')
})

test('Ctrl-N, Ctrl-P and Alt-digits switch tabs, wrapping', () => {
	startOn(['a', 'b', 'c'])
	app.onKeys([ctrl('p')])
	expect(shown()).toBe('c')
	app.onKeys([ctrl('n')])
	expect(shown()).toBe('a')
	app.onKeys([alt('2')])
	expect(shown()).toBe('b')
	// No tab 9: nothing happens.
	app.onKeys([alt('9')])
	expect(shown()).toBe('b')
	expect(sent.filter((c) => c.type === 'open').map((c) => c.sessionId)).toEqual(['c', 'b'])
})

test('/go changes this terminal only while it shows the source session', () => {
	startOn(['a', 'b', 'c'])
	app.onEvent({ type: 'go', sessionId: 'b', tab: 'c' })
	expect(shown()).toBe('a')
	app.onEvent({ type: 'go', sessionId: 'a', tab: 'b' })
	expect(shown()).toBe('b')
	expect(sent).toEqual([{ type: 'open', sessionId: 'b' }])
	app.onEvent({ type: 'go', sessionId: 'a', tab: 'c' })
	expect(shown()).toBe('b')
})

test('each tab keeps its editor state while another is shown; a modal closes on switch', () => {
	startOn(['a', 'b'])
	type('hello')
	app.onKeys([key('left'), key('left')])
	app.onKeys([ctrl('n')])
	expect(appView.view().prompt.text).toBe('')
	app.onEvent(snapshot('b'))
	type('x')
	app.open(modals.open({ title: 'Models', items: ['m'] }), () => undefined)
	app.onKeys([ctrl('p')])
	expect(appView.view().modal).toBeUndefined()
	expect(appView.view().prompt).toMatchObject({ text: 'hello', cursor: 3 })
	// Its transcript shows until the fresh snapshot replaces it.
	expect(appView.view().transcript?.meta.id).toBe('a')
	app.onEvent(snapshot('a'))
	expect(appView.view().prompt).toMatchObject({ text: 'hello', cursor: 3 })
	app.onKeys([ctrl('n')])
	expect(appView.view().prompt.text).toBe('x')
})

test('late events of a tab just left do not reach the view', () => {
	startOn(['a', 'b'])
	app.onKeys([ctrl('n')])
	app.onEvent(snapshot('a', { type: 'running', phase: 'streaming' }))
	expect(appView.view().transcript).toBeUndefined()
	app.onEvent(snapshot('b'))
	app.onEvent({ type: 'state', sessionId: 'a', state: { type: 'error', message: 'x' } })
	expect(appView.view().transcript?.state).toEqual({ type: 'idle' })
})

test('a shown tab that wants attention is told seen', () => {
	startOn(['a', 'b'])
	app.onEvent(tabsEvent('a', tabOf('b', { attention: true })))
	expect(sent).toEqual([])
	app.onEvent(tabsEvent(tabOf('a', { attention: true }), tabOf('b', { attention: true })))
	expect(sent).toEqual([{ type: 'tab-seen', sessionId: 'a' }])
	app.onKeys([ctrl('n')])
	expect(sent.at(-1)).toEqual({ type: 'tab-seen', sessionId: 'b' })
})

test('web links carry the latest link code only in their hidden target', () => {
	startOn(['a', 'b'])
	try {
		app.onEvent({ type: 'auth', code: 'k3x9qa', link: 'https://h.example' })
		app.onEvent({ type: 'output', sessionId: 'a', text: 'AGENTS.md changed', n: 1 })
		type('see [image/frdbn1.png]')
		let lines = frame.build(appView.view(), 60).lines
		let targets = lines.flatMap((l) => [...l.matchAll(/\x1b\]8;;([^\x07]+)\x07/g)].map((m) => m[1]))
		expect(targets).toEqual(
			expect.arrayContaining([
				'https://h.example/a?auth=k3x9qa',
				'https://h.example/b?auth=k3x9qa',
				'https://h.example/image/frdbn1.png?auth=k3x9qa',
			]),
		)
		expect(lines.map((l) => l.replace(/\x1b\]8;;[^\x07]*\x07/g, '')).join('\n')).not.toContain('k3x9qa')
		// A history item laid out before the server bound (on another port
		// than the preferred one) links to where it really listens.
		let item = () => frame.build(appView.view(), 60).lines.find((l) => l.includes('#s1'))
		expect(item()).toContain('https://h.example/a?auth=k3x9qa#s1')
		app.onEvent({ type: 'auth', code: 'k3x9qa', link: 'http://localhost:9003' })
		expect(item()).toContain('http://localhost:9003/a?auth=k3x9qa#s1')
		// A replaced code is what the next paint links with.
		app.onEvent({ type: 'auth', code: 'm2p7rt', link: 'https://h.example' })
		expect(frame.build(appView.view(), 60).lines.join('\n')).toContain('https://h.example/a?auth=m2p7rt')
		// A plain `auth` reply (./run auth) is not a link code.
		app.onEvent({ type: 'auth', code: 'zzzzzz' })
		expect(frame.build(appView.view(), 60).lines.join('\n')).not.toContain('zzzzzz')
	} finally {
		ansi.state.web = { url: '', code: '' }
	}
})

test('navigating to a cached tab uses the draft updated while it was hidden', () => {
	startOn(['a', 'b'])
	app.focusOn({ tab: 'b' })
	app.onEvent(snapshot('b'))
	app.focusOn({ tab: 'a' })
	app.onEvent({ type: 'draft', sessionId: 'b', draft: { text: 'written on another client', rev: 3 } })
	app.onEvent({ type: 'go', sessionId: 'a', tab: 'b' })
	expect(app.state.prompt.text).toBe('written on another client')
	type('!')
	expect(drafted.at(-1)).toMatchObject({ sessionId: 'b', text: 'written on another client!', base: 3 })
})

test('a synchronous navigation submit does not clear the destination editor', () => {
	startOn(['a', 'b'])
	app.focusOn({ tab: 'b' })
	app.onEvent(snapshot('b', { type: 'idle' }, { text: 'destination draft', rev: 7 }))
	app.focusOn({ tab: 'a' })
	type('/go b')
	drafts.send = (command: any) => {
		record(command)
		if (command.type === 'submit') app.onEvent({ type: 'go', sessionId: 'a', tab: 'b' })
	}
	enter()
	expect(shown()).toBe('b')
	expect(app.state.prompt.text).toBe('destination draft')
	app.focusOn({ tab: 'a' })
	expect(app.state.prompt.text).toBe('')
})

for (let restore of ['delete', 'undo'])
	test(`history continues after a recalled entry is edited and restored by ${restore}`, () => {
		sentBefore('first', 'second', 'third')
		up()
		up()
		expect(appView.view().prompt.text).toBe('second')
		type('!')
		app.onKeys([restore === 'undo' ? { ...key('z'), cmd: true } : key('backspace')])
		expect(appView.view().prompt.text).toBe('second')
		up()
		expect(appView.view().prompt.text).toBe('first')
		down()
		down()
		down()
		expect(appView.view().prompt.text).toBe('second')
		expect(drafts.text('s1')).toBe('second')
	})
