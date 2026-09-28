import { afterEach, beforeEach, expect, test } from 'bun:test'
import { connection } from '../common/connection.ts'
import { drafts, type Local } from '../common/drafts.ts'
import { placeholders } from '../common/placeholders.ts'
import type { Event } from '../common/protocol.ts'
import { app } from './app.ts'
import { keys, type Target } from './keys.ts'
import { router } from './router.ts'
import { tabs } from './tabs.ts'

const meta = { id: '1-abc', cwd: '/w', model: 'fake/m', createdAt: '2026-09-26T00:00:00Z' }
const sessionId = meta.id
const ts = '2026-09-26T00:00:01Z'

let sent: any[] = []
let stored = new Map<string, Local>()
let redraws = 0
const orig = { send: connection.send, connected: connection.connected, store: drafts.store, href: router.href, write: router.write, tabStore: { ...router.store }, mac: tabs.mac }
let address = 'http://h/'
let history: string[] = []
let lastTab = undefined as string | undefined

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
	address = 'http://h/'
	history = [address]
	lastTab = undefined
	router.href = () => address
	router.write = (url, replace) => {
		address = new URL(url, address).href
		if (replace) history[history.length - 1] = address
		else history.push(address)
	}
	router.store.load = () => lastTab
	router.store.save = (id) => void (lastTab = id)
	tabs.mac = () => true
})

afterEach(() => {
	connection.send = orig.send
	connection.connected = orig.connected
	drafts.store = orig.store
	Object.assign(router, { href: orig.href, write: orig.write })
	Object.assign(router.store, orig.tabStore)
	tabs.mac = orig.mac
	drafts.reset()
	app.reset()
})

const press = (key: string, target: Target, mods: Partial<Record<'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey', boolean>> = {}) =>
	keys.key({ key, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...mods }, target)
const message = (text: string, cursor = text.length): Target => ({ kind: 'message', text, cursor })
const snapshot = (state: object, history: object[] = [], draft?: object): Event =>
	({ type: 'snapshot', sessionId, snapshot: { meta, history, state, ...(draft ? { draft } : {}) } }) as Event

test('Enter sends the message box as a prompt: it shows pending and the box empties', () => {
	app.onEvent(snapshot({ type: 'idle' }))
	// Text put in the box without an input event is what gets sent.
	expect(press('Enter', message('hi'))).toBe(true)
	expect(sent.find((c) => c.type === 'submit')).toMatchObject({ sessionId, text: 'hi' })
	expect(app.pending().map((s) => s.text)).toEqual(['hi'])
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
	expect(press('ArrowUp', message('draft\nmore'))).toBe(false)
	app.input('')
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
	expect(press('Tab', message('/cd ~/p', 0))).toBe(false)
	expect(press('Tab', message('/cd ~/p'))).toBe(true)
	expect(sent.at(-1)).toMatchObject({ type: 'complete', sessionId, text: '/cd ~/p' })
	app.onEvent({ type: 'completions', sessionId, text: '/cd ~/p', items: ['/cd ~/projects/'] })
	expect(app.state.text).toBe('/cd ~/projects/')
})

test('typing opens host completions; keyboard choice is not sent, stale answers and Escape stay hidden', () => {
	app.onEvent(snapshot({ type: 'idle' }))
	app.input('/c')
	expect(sent).toContainEqual(expect.objectContaining({ type: 'complete', text: '/c' }))
	app.onEvent({ type: 'completions', sessionId, text: '/c', items: ['/cd ', '/clear '] })
	expect(app.state.menu?.choices).toHaveLength(2)
	expect(press('ArrowDown', message('/c'))).toBe(true)
	expect(press('Enter', message('/c'))).toBe(true)
	expect(app.state.text).toBe('/clear ')
	expect(app.state.menu).toBeUndefined()
	app.input('/c')
	app.onEvent({ type: 'completions', sessionId, text: '/clear ', items: ['/clear '] })
	expect(app.state.menu).toBeUndefined()
	app.onEvent({ type: 'completions', sessionId, text: '/c', items: ['/cd ', '/clear '] })
	expect(press('Escape', message('/c'))).toBe(true)
	app.onEvent({ type: 'completions', sessionId, text: '/c', items: ['/cd ', '/clear '] })
	expect(app.state.menu).toBeUndefined()
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
	app.modalPick(app.state.view.modal!.items.findIndex((item) => item.includes('x/y')))
	expect(sent.at(-1)).toMatchObject({ type: 'submit', text: '/model x/y' })
	expect(app.state.view.modal).toBeUndefined()
})

test('the link state shows as a notice until connected', () => {
	app.onState({ type: 'disconnected', retryAt: 0 })
	expect(app.notice()).toMatch(/reconnect/)
	app.onState({ type: 'connected', role: 'client' })
	expect(app.notice()).toBeUndefined()
})

test('the Send button sends what the box holds, like Enter', () => {
	app.onEvent(snapshot({ type: 'idle' }))
	app.input('from the button')
	app.send()
	expect(sent.find((c) => c.type === 'submit')).toMatchObject({ sessionId, text: 'from the button' })
	expect(app.state.text).toBe('')
})

test('Ctrl-K, Ctrl-U, Alt-D, Alt-Backspace and Ctrl-Y edit the box through the shared editor, as native edits', () => {
	app.onEvent(snapshot({ type: 'idle' }))
	let edits: unknown[] = []
	let box = (text: string, cursor: number): Target => ({ kind: 'message', text, cursor, write: (e, at) => void edits.push([e, at]) })
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
})

test('Tab and Shift-Tab indent a selection that spans lines; otherwise they move focus', () => {
	app.onEvent(snapshot({ type: 'idle' }))
	let edits: unknown[] = []
	let box = (text: string, cursor: number, anchor?: number): Target => ({ kind: 'message', text, cursor, anchor, write: (...a) => void edits.push(a) })
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
})

test('Ctrl-Y replaces the selection in the box', () => {
	app.onEvent(snapshot({ type: 'idle' }))
	press('k', { kind: 'message', text: 'ab', cursor: 1 }, { ctrlKey: true })
	let edits: unknown[] = []
	press('y', { kind: 'message', text: 'a', cursor: 0, anchor: 1, write: (...a) => void edits.push(a) }, { ctrlKey: true })
	expect(app.state.text).toBe('b')
	expect(edits).toEqual([[{ start: 0, end: 1, text: 'b' }, 1, 1]])
})

test('keys the browser already handles stay native in the box', () => {
	app.onEvent(snapshot({ type: 'idle' }))
	for (let [key, mods] of [['ArrowLeft', { altKey: true }], ['Backspace', {}], ['a', { ctrlKey: true }], ['e', { ctrlKey: true }], ['z', { metaKey: true }]] as const)
		expect(press(key, message('hello world', 5), mods)).toBe(false)
	expect(app.state.text).toBe('hello world')
})

// ── Tabs ──

const tab = (id: string, extra: object = {}) => ({ id, name: `name ${id}`, cwd: `/cwd/${id}`, model: 'fake/m', state: { type: 'idle' }, ...extra })
const tabsEvent = (...tabs: object[]) => ({ type: 'tabs', tabs }) as Event
const snapOf = (id: string, draft?: string): Event =>
	({ type: 'snapshot', sessionId: id, snapshot: { meta: { ...meta, id }, history: [], state: { type: 'idle' }, ...(draft ? { draft: { text: draft, rev: 1 } } : {}) } }) as Event
const alt = (digit: number) => press(String(digit), message(app.state.text), { altKey: true, code: `Digit${digit}` } as any)

test('the empty box shows an example request, from the Hal list in a tab the host marks hal', () => {
	app.onEvent(tabsEvent(tab('1-aaa'), tab('2-bbb', { hal: true })))
	expect(app.state.shown).toBe('1-aaa')
	expect(app.placeholder()).toBeUndefined()
	app.onEvent(snapOf('1-aaa'))
	expect(app.placeholder()).toBe(placeholders.general[0])
	tabs.show('2-bbb', false)
	app.onEvent(snapOf('2-bbb'))
	expect(app.placeholder()).toBe(placeholders.hal[0])
})

test('a page opened at a tab address asks tab-start for it and shows it without a new history entry', () => {
	address = 'http://h/2-bbb'
	history = [address]
	app.onState({ type: 'connected', role: 'client' })
	expect(sent).toContainEqual({ type: 'tab-start', last: '2-bbb' })
	app.onEvent(tabsEvent(tab('1-aaa'), tab('2-bbb')))
	expect(app.state.shown).toBe('2-bbb')
	expect(sent).toContainEqual({ type: 'open', sessionId: '2-bbb' })
	expect(history).toEqual(['http://h/2-bbb'])
	// A snapshot of another session is not this page's transcript.
	app.onEvent(snapOf('1-aaa'))
	expect(app.sessionId()).toBeUndefined()
	app.onEvent(snapOf('2-bbb'))
	expect(app.sessionId()).toBe('2-bbb')
})

test('with no valid id the page lands on the tab shown last, else the first, replacing the entry', () => {
	address = 'http://h/9-zzz'
	history = [address]
	lastTab = '2-bbb'
	app.onState({ type: 'connected', role: 'client' })
	app.onEvent(tabsEvent(tab('1-aaa'), tab('2-bbb')))
	expect(history).toEqual(['http://h/2-bbb'])
	app.reset()
	address = 'http://h/'
	history = [address]
	lastTab = undefined
	app.onEvent(tabsEvent(tab('1-aaa'), tab('2-bbb')))
	expect(history).toEqual(['http://h/1-aaa'])
	expect(router.store.load()).toBe('1-aaa')
})

test('background neighbours fetch after paint and switching reuses their in-memory transcripts', async () => {
	address = 'http://h/2-bbb'
	app.onEvent(tabsEvent(tab('1-aaa'), tab('2-bbb'), tab('3-ccc'), tab('4-ddd')))
	app.onEvent(snapOf('2-bbb'))
	expect(sent.filter((c) => c.type === 'open').map((c) => c.sessionId)).toEqual(['2-bbb'])
	await Bun.sleep(10)
	expect(sent.at(-1)).toEqual({ type: 'open', sessionId: '1-aaa' })
	app.onEvent(snapOf('1-aaa'))
	await Bun.sleep(10)
	expect(sent.at(-1)).toEqual({ type: 'open', sessionId: '3-ccc' })
	app.onEvent(snapOf('3-ccc'))
	await Bun.sleep(10)
	expect(sent.at(-1)).toEqual({ type: 'open', sessionId: '4-ddd' })
	app.onEvent(snapOf('4-ddd'))
	let opens = sent.filter((c) => c.type === 'open').length
	tabs.show('3-ccc', false)
	expect(app.sessionId()).toBe('3-ccc')
	expect(sent.filter((c) => c.type === 'open').length).toBe(opens)
})

test('choosing a tab pushes an entry, moves the following, and each tab keeps its draft; Back returns', () => {
	app.onEvent(tabsEvent(tab('1-aaa'), tab('2-bbb'), tab('3-ccc')))
	app.onEvent(snapOf('1-aaa'))
	app.input('draft one')
	sent = []
	expect(alt(3)).toBe(true)
	expect(app.state.shown).toBe('3-ccc')
	expect(sent).not.toContainEqual({ type: 'close', sessionId: '1-aaa' })
	expect(sent).toContainEqual({ type: 'open', sessionId: '3-ccc' })
	expect(app.state.text).toBe('')
	expect(history).toEqual(['http://h/1-aaa', 'http://h/3-ccc'])
	// Ctrl-N wraps to the first, Ctrl-P back to the last.
	press('n', message(''), { ctrlKey: true })
	expect(app.state.shown).toBe('1-aaa')
	expect(app.state.text).toBe('draft one')
	press('p', message('draft one'), { ctrlKey: true })
	expect(app.state.shown).toBe('3-ccc')
	// Back: the address names tab 1 again; nothing is written.
	history.pop()
	address = history.at(-1)!
	let entries = history.length
	tabs.onPopState()
	expect(app.state.shown).toBe('1-aaa')
	expect(history.length).toBe(entries)
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
	expect(history).toEqual(['http://h/1-aaa', 'http://h/2-bbb'])
	app.onEvent({ type: 'go', sessionId: '1-aaa', tab: '3-ccc' })
	expect(app.state.shown).toBe('2-bbb')
})

test('when the shown tab closes, the page lands on its neighbour, replacing the entry', () => {
	app.onEvent(tabsEvent(tab('1-aaa'), tab('2-bbb'), tab('3-ccc')))
	alt(2)
	sent = []
	press('w', message(''), { ctrlKey: true })
	expect(sent).toContainEqual({ type: 'tab-close', sessionId: '2-bbb' })
	app.onEvent(tabsEvent(tab('1-aaa'), tab('3-ccc')))
	expect(app.state.shown).toBe('3-ccc')
	expect(history).toEqual(['http://h/1-aaa', 'http://h/3-ccc'])
})

test('a new tab opens in the shown tab cwd, after it, and shows once the host names it', () => {
	app.onEvent(tabsEvent(tab('1-aaa'), tab('2-bbb')))
	sent = []
	press('t', message(''), { ctrlKey: true })
	let c = sent.find((c) => c.type === 'tab-new')
	expect(c).toMatchObject({ cwd: '/cwd/1-aaa', after: '1-aaa' })
	app.onEvent(tabsEvent(tab('1-aaa'), tab('4-ddd'), tab('2-bbb')))
	expect(app.state.shown).toBe('1-aaa')
	// Another client's new tab does not steal the page.
	app.onEvent({ type: 'ack', id: 'someone-else', tab: '2-bbb' } as Event)
	expect(app.state.shown).toBe('1-aaa')
	app.onEvent({ type: 'ack', id: c.id, tab: '4-ddd' } as Event)
	expect(app.state.shown).toBe('4-ddd')
	expect(history.at(-1)).toBe('http://h/4-ddd')
})

test('the shown tab wanting attention is marked seen; other tabs keep theirs', () => {
	app.onEvent(tabsEvent(tab('1-aaa'), tab('2-bbb', { attention: true })))
	expect(sent.filter((c) => c.type === 'tab-seen')).toEqual([])
	app.onEvent(tabsEvent(tab('1-aaa', { attention: true }), tab('2-bbb', { attention: true })))
	expect(sent.filter((c) => c.type === 'tab-seen')).toEqual([{ type: 'tab-seen', sessionId: '1-aaa' }])
	alt(2)
	expect(sent.filter((c) => c.type === 'tab-seen').at(-1)).toEqual({ type: 'tab-seen', sessionId: '2-bbb' })
})

test('Ctrl-T/W/N/P stay the browser\'s off macOS', () => {
	tabs.mac = () => false
	app.onEvent(tabsEvent(tab('1-aaa'), tab('2-bbb')))
	sent = []
	expect(press('t', message(''), { ctrlKey: true })).toBe(false)
	expect(press('n', message(''), { ctrlKey: true })).toBe(false)
	expect(sent).toEqual([])
})

test('Up on the first line and Down on the last browse the prompts sent; the draft stays the own text', () => {
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
	app.input('mine')
	// A selection, or the caret after a newline, keeps the key native.
	expect(press('ArrowUp', box('mine', 0, 4))).toBe(false)
	expect(press('ArrowUp', box('mine\nx'))).toBe(false)
	app.input('mine')
	expect(press('ArrowUp', box('mine', 2))).toBe(true)
	expect(writes.at(-1)).toEqual(['two\nlines', 9])
	expect(app.state.text).toBe('two\nlines')
	expect(stored.get(sessionId)?.text).toBe('mine')
	expect(press('ArrowUp', box('two\nlines', 3))).toBe(true)
	expect(writes.at(-1)).toEqual(['first', 5])
	// The oldest: native Up goes to the start.
	expect(press('ArrowUp', box('first'))).toBe(false)
	expect(press('ArrowDown', box('first'))).toBe(true)
	expect(writes.at(-1)).toEqual(['two\nlines', 3])
	expect(press('ArrowDown', box('two\nlines', 3))).toBe(false)
	expect(press('ArrowDown', box('two\nlines'))).toBe(true)
	expect(writes.at(-1)).toEqual(['mine', 4])
	expect(app.state.text).toBe('mine')
})

test('an edited entry becomes the draft; sending an entry brings the own text back', () => {
	app.onEvent(snapshot({ type: 'idle' }, [{ type: 'user', blocks: [{ type: 'text', text: 'first' }], ts }]))
	app.input('mine')
	press('ArrowUp', message('mine'))
	expect(app.state.text).toBe('first')
	app.input('first!')
	expect(stored.get(sessionId)?.text).toBe('first!')
	expect(press('ArrowDown', message('first!'))).toBe(false)
	app.input('mine')
	press('ArrowUp', message('mine'))
	press('Enter', message('first'))
	expect(sent.findLast((c) => c.type === 'submit')).toMatchObject({ text: 'first' })
	expect(app.state.text).toBe('mine')
	expect(stored.get(sessionId)?.text).toBe('mine')
})

test('scrolling near the top fetches the page before; it goes in front', () => {
	let turn = (n: number) => [
		{ type: 'user', blocks: [{ type: 'text', text: `p${n}` }], ts },
		{ type: 'assistant', block: { type: 'text', text: `a${n}` }, ts },
		{ type: 'turn_end', status: 'completed', usage: {}, ts },
	]
	let open = { type: 'question', id: 'q', form: { text: 'Ok?', fields: [{ type: 'text', name: 'x' }] }, ts }
	// The tail is turn 3; the open question and the last prompt are further back.
	app.onEvent({ type: 'snapshot', sessionId, snapshot: { meta, history: [...turn(3)], state: { type: 'idle' }, older: 200, earlier: [] } } as Event)
	app.older()
	app.older()
	expect(sent.filter((c) => c.type === 'history')).toEqual([expect.objectContaining({ sessionId, before: 200 })])
	// A page for a spot nobody asked for is ignored.
	app.onEvent({ type: 'history', sessionId, before: 999, records: turn(9) } as Event)
	expect(app.state.pages).toBe(0)
	app.onEvent({ type: 'history', sessionId, before: 200, records: turn(2), older: 100 } as Event)
	expect(app.state.pages).toBe(1)
	expect(app.state.view.transcript!.items.map((i: any) => i.text ?? i.type)).toEqual(['p2', 'a2', 'turn-end', 'p3', 'a3', 'turn-end'])
	app.older()
	app.onEvent({ type: 'history', sessionId, before: 100, records: [...turn(1), open] } as Event)
	expect(app.state.view.transcript!.items.map((i: any) => i.text ?? i.type).slice(0, 4)).toEqual(['p1', 'a1', 'turn-end', 'question'])
	sent = []
	app.older()
	expect(sent).toEqual([])
})
