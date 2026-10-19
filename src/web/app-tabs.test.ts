// Tabs in the web client: which tab the page shows, its address and
// browser history, switching keys and per-tab drafts.

import { expect, test } from 'bun:test'
import { placeholders } from '../common/placeholders.ts'
import type { Event } from '../common/protocol.ts'
import { app } from './app.ts'
import { router } from './router.ts'
import { tabs } from './tabs.ts'
import { useApp, alt, fx, message, press, snapOf, tab, tabsEvent } from './app-fixture.test.ts'

useApp()

test('the empty box shows an example request, from the Hal list in a tab the host marks hal', () => {
	app.onEvent(tabsEvent(tab('1-aaa'), tab('2-bbb', { hal: true })))
	expect(app.state.shown).toBe('1-aaa')
	expect(app.placeholder('', 0)).toBeUndefined()
	app.onEvent(snapOf('1-aaa'))
	expect(app.placeholder('', 0)?.text).toBe(placeholders.general[0])
	tabs.show('2-bbb', false)
	app.onEvent(snapOf('2-bbb'))
	expect(app.placeholder('', 0)?.text).toBe(placeholders.hal[0])
})

test('a block address resumes even a closed session, retaining its hash and history entry', () => {
	fx.address = 'http://h/2-bbb#5'
	fx.history = [fx.address]
	app.onState({ type: 'connected', role: 'client' })
	expect(fx.sent).toContainEqual({
		type: 'tab-resume',
		id: expect.any(String),
		sessionId: '2-bbb',
		timezone: expect.any(String),
	})
	app.onEvent(tabsEvent(tab('1-aaa')))
	expect(app.state.shown).toBeUndefined()
	app.onEvent(tabsEvent(tab('1-aaa'), tab('2-bbb')))
	expect(app.state.shown).toBe('2-bbb')
	expect(fx.sent).toContainEqual({ type: 'open', sessionId: '2-bbb' })
	expect(fx.history).toEqual(['http://h/2-bbb#5'])
	// A snapshot of another session is not this page's transcript.
	app.onEvent(snapOf('1-aaa'))
	expect(app.sessionId()).toBeUndefined()
	app.onEvent(snapOf('2-bbb'))
	expect(app.sessionId()).toBe('2-bbb')
})

test('with no valid id the page lands on the tab shown last, else the first, replacing the entry', () => {
	fx.address = 'http://h/9-zzz'
	fx.history = [fx.address]
	fx.lastTab = '2-bbb'
	app.onState({ type: 'connected', role: 'client' })
	app.onEvent(tabsEvent(tab('1-aaa'), tab('2-bbb')))
	app.onEvent({
		type: 'rejected',
		id: fx.sent.find((c) => c.type === 'tab-resume').id,
		command: 'tab-resume',
		reason: 'no such session',
	})
	expect(fx.history).toEqual(['http://h/2-bbb'])
	app.reset()
	fx.address = 'http://h/'
	fx.history = [fx.address]
	fx.lastTab = undefined
	app.onEvent(tabsEvent(tab('1-aaa'), tab('2-bbb')))
	expect(fx.history).toEqual(['http://h/1-aaa'])
	expect(router.store.load()).toBe('1-aaa')
})

test('background neighbors fetch after paint and switching reuses their in-memory transcripts', async () => {
	fx.address = 'http://h/2-bbb'
	app.onEvent(tabsEvent(tab('1-aaa'), tab('2-bbb'), tab('3-ccc'), tab('4-ddd')))
	app.onEvent(snapOf('2-bbb'))
	expect(fx.sent.filter((c) => c.type === 'open').map((c) => c.sessionId)).toEqual(['2-bbb'])
	await Bun.sleep(10)
	expect(fx.sent.at(-1)).toEqual({ type: 'open', sessionId: '1-aaa' })
	app.onEvent(snapOf('1-aaa'))
	await Bun.sleep(10)
	expect(fx.sent.at(-1)).toEqual({ type: 'open', sessionId: '3-ccc' })
	app.onEvent(snapOf('3-ccc'))
	await Bun.sleep(10)
	expect(fx.sent.at(-1)).toEqual({ type: 'open', sessionId: '4-ddd' })
	app.onEvent(snapOf('4-ddd'))
	let opens = fx.sent.filter((c) => c.type === 'open').length
	tabs.show('3-ccc', false)
	expect(app.sessionId()).toBe('3-ccc')
	expect(fx.sent.filter((c) => c.type === 'open').length).toBe(opens)
})

test('choosing a tab pushes an entry, moves the following, and each tab keeps its draft; Back returns', () => {
	app.onEvent(tabsEvent(tab('1-aaa'), tab('2-bbb'), tab('3-ccc')))
	app.onEvent(snapOf('1-aaa'))
	app.input('draft one')
	fx.sent = []
	expect(alt(3)).toBe(true)
	expect(app.state.shown).toBe('3-ccc')
	expect(fx.sent).not.toContainEqual({ type: 'close', sessionId: '1-aaa' })
	expect(fx.sent).toContainEqual({ type: 'open', sessionId: '3-ccc' })
	expect(app.state.text).toBe('')
	expect(fx.history).toEqual(['http://h/1-aaa', 'http://h/3-ccc'])
	// Ctrl-N wraps to the first, Ctrl-P back to the last.
	press('n', message(''), { ctrlKey: true })
	expect(app.state.shown).toBe('1-aaa')
	expect(app.state.text).toBe('draft one')
	press('p', message('draft one'), { ctrlKey: true })
	expect(app.state.shown).toBe('3-ccc')
	// Back: the address names tab 1 again; nothing is written.
	fx.history.pop()
	fx.address = fx.history.at(-1)!
	let entries = fx.history.length
	tabs.onPopState()
	expect(app.state.shown).toBe('1-aaa')
	expect(fx.history.length).toBe(entries)
	// Alt with no such tab does nothing.
	alt(9)
	expect(app.state.shown).toBe('1-aaa')
})

test('/go changes this page only if it currently shows the source tab', () => {
	app.onEvent(tabsEvent(tab('1-aaa'), tab('2-bbb'), tab('3-ccc')))
	app.onEvent({ type: 'go', sessionId: '2-bbb', tab: '3-ccc' })
	expect(app.state.shown).toBe('1-aaa')
	app.onEvent({ type: 'go', sessionId: '1-aaa', tab: '2-bbb' })
	expect(app.state.shown).toBe('2-bbb')
	expect(fx.history).toEqual(['http://h/1-aaa', 'http://h/2-bbb'])
	app.onEvent({ type: 'go', sessionId: '1-aaa', tab: '3-ccc' })
	expect(app.state.shown).toBe('2-bbb')
})

test('when the shown tab closes, the page lands on its neighbor, replacing the entry', () => {
	app.onEvent(tabsEvent(tab('1-aaa'), tab('2-bbb'), tab('3-ccc')))
	alt(2)
	fx.sent = []
	press('w', message(''), { ctrlKey: true })
	expect(fx.sent).toContainEqual({ type: 'tab-close', sessionId: '2-bbb' })
	app.onEvent(tabsEvent(tab('1-aaa'), tab('3-ccc')))
	expect(app.state.shown).toBe('3-ccc')
	expect(fx.history).toEqual(['http://h/1-aaa', 'http://h/3-ccc'])
})

test('a new tab opens in the shown tab cwd, after it, and shows once the host names it', () => {
	app.onEvent(tabsEvent(tab('1-aaa'), tab('2-bbb')))
	fx.sent = []
	press('t', message(''), { ctrlKey: true })
	let c = fx.sent.find((c) => c.type === 'tab-new')
	expect(c).toMatchObject({ cwd: '/cwd/1-aaa', after: '1-aaa' })
	app.onEvent(tabsEvent(tab('1-aaa'), tab('4-ddd'), tab('2-bbb')))
	expect(app.state.shown).toBe('1-aaa')
	// Another client's new tab does not steal the page.
	app.onEvent({ type: 'ack', id: 'someone-else', tab: '2-bbb' } as Event)
	expect(app.state.shown).toBe('1-aaa')
	app.onEvent({ type: 'ack', id: c.id, tab: '4-ddd' } as Event)
	expect(app.state.shown).toBe('4-ddd')
	expect(fx.history.at(-1)).toBe('http://h/4-ddd')
})

test('the shown tab wanting attention is marked seen; other tabs keep theirs', () => {
	app.onEvent(tabsEvent(tab('1-aaa'), tab('2-bbb', { attention: true })))
	expect(fx.sent.filter((c) => c.type === 'tab-seen')).toEqual([])
	app.onEvent(tabsEvent(tab('1-aaa', { attention: true }), tab('2-bbb', { attention: true })))
	expect(fx.sent.filter((c) => c.type === 'tab-seen')).toEqual([{ type: 'tab-seen', sessionId: '1-aaa' }])
	alt(2)
	expect(fx.sent.filter((c) => c.type === 'tab-seen').at(-1)).toEqual({ type: 'tab-seen', sessionId: '2-bbb' })
})

test("Ctrl-T/W/N/P stay the browser's off macOS", () => {
	tabs.mac = () => false
	app.onEvent(tabsEvent(tab('1-aaa'), tab('2-bbb')))
	fx.sent = []
	expect(press('t', message(''), { ctrlKey: true })).toBe(false)
	expect(press('n', message(''), { ctrlKey: true })).toBe(false)
	expect(fx.sent).toEqual([])
})

test('/go shows a cached destination draft updated by another client without writing it', () => {
	app.onEvent(tabsEvent(tab('1-aaa'), tab('2-bbb')))
	app.onEvent(snapOf('1-aaa'))
	tabs.show('2-bbb', false)
	app.onEvent(snapOf('2-bbb'))
	tabs.show('1-aaa', false)
	app.onEvent({ type: 'draft', sessionId: '2-bbb', draft: { text: 'from terminal', rev: 5 } })
	app.input('/go 2-bbb')
	app.send()
	fx.sent = []
	app.onEvent({ type: 'go', sessionId: '1-aaa', tab: '2-bbb' })
	expect(app.state.text).toBe('from terminal')
	expect(fx.sent.filter((c) => c.type === 'draft')).toEqual([])
	app.input('from terminal!')
	expect(fx.sent.find((c) => c.type === 'draft')).toMatchObject({ sessionId: '2-bbb', text: 'from terminal!', base: 5 })
})
