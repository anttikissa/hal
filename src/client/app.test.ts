import { afterEach, beforeEach, expect, test } from 'bun:test'
import { drafts } from '../common/drafts.ts'
import { modals } from '../common/modals.ts'
import { placeholders } from '../common/placeholders.ts'
import type { Event, Snapshot, Tab } from '../common/protocol.ts'
import type { SessionState } from '../common/states.ts'
import { app } from './app.ts'
import { frame } from './frame.ts'
import type { KeyEvent } from './keys.ts'
import { render } from './render.ts'
import { terminal } from './terminal.ts'

// The app with a recording link and renderer: what the user types
// becomes commands, and what the host says becomes the view.

// Commands as sent, ids left out; draft updates are in `drafted`.
let sent: any[] = []
let drafted: any[] = []
let quits = 0
const saved = { send: app.send, show: render.show, quit: terminal.quit, draftSend: drafts.send }
const record = (c: any) => {
	let { id: _id, ...rest } = c
	if (c.type === 'draft') drafted.push(rest)
	else sent.push(rest)
}

beforeEach(() => {
	sent = []
	drafted = []
	quits = 0
	app.reset()
	app.send = record
	drafts.send = record
	render.show = () => {}
	terminal.quit = () => {
		quits++
	}
})

afterEach(() => {
	Object.assign(app, { send: saved.send })
	drafts.send = saved.draftSend
	render.show = saved.show
	terminal.quit = saved.quit
	app.reset()
})

const snapshot = (id = 's1', state: SessionState = { type: 'idle' }, draft?: Snapshot['draft']): Event => {
	let snap: Snapshot = { meta: { id, cwd: '/', model: 'anthropic/x', createdAt: '' }, history: [], state }
	if (draft) snap.draft = draft
	return { type: 'snapshot', sessionId: id, snapshot: snap }
}
const key = (key: string, text?: string): KeyEvent => ({ key, text, shift: false, alt: false, ctrl: false, cmd: false })
const type = (s: string) => app.onKeys([...s].map((c) => key(c, c)))
const enter = () => app.onKeys([key('enter')])
const escape = () => app.onKeys([key('escape')])

test('typing and Enter submits to the open session and clears the prompt', () => {
	app.onEvent(snapshot())
	type('hello')
	enter()
	expect(sent).toEqual([{ type: 'submit', sessionId: 's1', text: 'hello' }])
	expect(app.view().prompt.text).toBe('')
})

test('an empty prompt is not submitted', () => {
	app.onEvent(snapshot())
	type('  ')
	enter()
	expect(sent).toEqual([])
})

test('a submit before any session arrives keeps the text', () => {
	type('early')
	enter()
	expect(sent).toEqual([])
	expect(app.view().prompt.text).toBe('early')
	expect(app.view().notice).toBeTruthy()
})

test('while a turn runs, Enter steers it, Alt-Enter queues, and Escape pauses it', () => {
	app.onEvent(snapshot())
	app.onEvent({ type: 'turn-start', sessionId: 's1', prompt: 'q', provider: 'anthropic' })
	app.onEvent({ type: 'state', sessionId: 's1', state: { type: 'running', phase: 'requesting' } })
	type('now')
	enter()
	expect(app.view().prompt.text).toBe('')
	type('later')
	app.onKeys([{ ...key('enter'), alt: true }])
	escape()
	expect(sent).toEqual([
		{ type: 'submit', sessionId: 's1', text: 'now' },
		{ type: 'submit', sessionId: 's1', text: 'later', queue: true },
		{ type: 'pause', sessionId: 's1' },
	])
})

test('waiting messages stay on screen, each saying why it waits', () => {
	app.onEvent(snapshot('s1', { type: 'running', phase: 'streaming' }))
	app.onEvent({ type: 'inbox', sessionId: 's1', inbox: [{ id: 'a', text: 'steer me' }, { id: 'b', text: 'run me later', queue: true }] })
	let rows = () => frame.build(app.view(), 80).lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trim())
	let steer = rows().find((r) => r.includes('steer me'))!
	let later = rows().find((r) => r.includes('run me later'))!
	expect(steer).not.toBe(later)
	expect(steer.replace('steer me', '')).not.toBe(later.replace('run me later', ''))
	app.onEvent({ type: 'state', sessionId: 's1', state: { type: 'paused' } })
	expect(rows().find((r) => r.includes('run me later'))).toMatch(/paused/)
	app.onEvent({ type: 'inbox', sessionId: 's1', inbox: [] })
	expect(rows().join('\n')).not.toContain('steer me')
})

test('Escape pauses a turn another host is carrying on, too', () => {
	app.onEvent(snapshot('s1', { type: 'running', phase: 'requesting' }))
	escape()
	expect(sent).toEqual([{ type: 'pause', sessionId: 's1' }])
})

test('bare Enter continues a paused or failed turn, and says so', () => {
	app.onEvent(snapshot('s1', { type: 'paused' }))
	expect(app.view().notice).toMatch(/paused.*Enter/)
	enter()
	app.onEvent({ type: 'state', sessionId: 's1', state: { type: 'error', message: '400 nope' } })
	expect(app.view().notice).toMatch(/400 nope/)
	enter()
	expect(sent).toEqual([
		{ type: 'continue', sessionId: 's1' },
		{ type: 'continue', sessionId: 's1' },
	])
})

// A session working on `prompt`, as the host would show it.
function working(prompt = 'fix ti') {
	app.onEvent(snapshot('s1', { type: 'running', phase: 'streaming' }))
	app.onEvent({ type: 'turn-start', sessionId: 's1', prompt, provider: 'anthropic' })
}
const up = () => app.onKeys([key('up')])
const down = () => app.onKeys([key('down')])
const paused = () => app.onEvent({ type: 'state', sessionId: 's1', state: { type: 'paused' } })

test('Up on an empty prompt while the model works pauses it and edits the last prompt; Enter sends the edit', () => {
	working()
	up()
	expect(sent).toEqual([{ type: 'pause', sessionId: 's1' }])
	expect(app.view().prompt).toEqual({ text: 'fix ti', cursor: 6 })
	expect(app.view().notice).toMatch(/editing/)
	paused()
	app.onKeys([key('backspace'), key('backspace'), key('i', 'i'), key('t', 't')])
	enter()
	expect(sent.at(-1)).toEqual({ type: 'submit', sessionId: 's1', text: 'fix it', amend: true })
	expect(app.view().prompt.text).toBe('')
	// The edit is over: the next prompt is a new one.
	type('more')
	enter()
	expect(sent.at(-1)).toEqual({ type: 'submit', sessionId: 's1', text: 'more' })
})

test('an edit not yet acknowledged is sent again as an edit by the next client', () => {
	let stored = new Map<string, any>()
	let store = drafts.store
	drafts.store = { load: (id) => stored.get(id) && structuredClone(stored.get(id)), save: (id, l) => void stored.set(id, structuredClone(l)) }
	try {
		working()
		up()
		paused()
		type('!')
		enter()
		// The client crashes before the ack; a new one connects.
		app.reset()
		sent = []
		app.onEvent(snapshot('s1', { type: 'running', phase: 'requesting' }))
		expect(sent).toEqual([{ type: 'submit', sessionId: 's1', text: 'fix ti!', amend: true }])
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
	expect(app.view().prompt.text).toBe('')
	app.onEvent({ type: 'state', sessionId: 's1', state: { type: 'running', phase: 'streaming' } })
	sent = []
	up()
	paused()
	type('!')
	// Changed: Down is no way out; Escape is, keeping the text typed.
	down()
	expect(sent).toEqual([{ type: 'pause', sessionId: 's1' }])
	escape()
	expect(sent.at(-1)).toEqual({ type: 'continue', sessionId: 's1' })
	expect(app.view().prompt.text).toBe('fix ti!')
	expect(app.view().notice ?? '').not.toMatch(/editing/)
})

test('Up does nothing with text typed or when nothing works', () => {
	working()
	type('x')
	up()
	app.onKeys([key('end'), key('backspace')])
	paused()
	up()
	expect(sent).toEqual([])
	// Not an edit: input history recalls the prompt instead.
	expect(app.view().notice ?? '').not.toMatch(/editing/)
})

test('Escape with no turn running sends nothing', () => {
	app.onEvent(snapshot())
	escape()
	expect(sent).toEqual([])
})

test('streamed output reaches the view', () => {
	app.onEvent(snapshot())
	app.onEvent({ type: 'turn-start', sessionId: 's1', prompt: 'q', provider: 'anthropic' })
	app.onEvent({ type: 'stream', sessionId: 's1', event: { type: 'text', text: 'answer' } })
	expect(app.view().transcript?.items).toContainEqual({ type: 'text', text: 'answer' })
})

test('history from a snapshot is marked as old; what follows comes after the mark', () => {
	let history: Snapshot['history'] = [
		{ type: 'user', blocks: [{ type: 'text', text: 'old question' }], ts: '2026-09-26T00:50:00Z' },
		{ type: 'turn_end', status: 'error', error: 'overloaded', usage: {}, ts: '2026-09-26T00:51:00Z' },
	]
	app.onEvent({ type: 'snapshot', sessionId: 's1', snapshot: { meta: { id: 's1', cwd: '/', model: 'anthropic/x', createdAt: '' }, history, state: { type: 'idle' } } })
	app.onEvent({ type: 'turn-start', sessionId: 's1', prompt: 'new question', provider: 'anthropic' })
	let rows = frame.build(app.view(), 80).lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trim()).filter(Boolean)
	let at = (s: string) => rows.findIndex((r) => r.includes(s))
	expect(at('error: overloaded')).toBeLessThan(at('resumed · last turn'))
	expect(at('resumed · last turn')).toBeLessThan(at('new question'))
	// A session that starts empty has nothing old to mark.
	app.reset()
	app.onEvent(snapshot())
	expect(frame.build(app.view(), 80).lines.join('')).not.toContain('resumed')
})

test('a refused command is shown until the next submit', () => {
	app.onEvent(snapshot())
	app.onEvent({ type: 'rejected', sessionId: 's1', command: 'submit', reason: 'disk full' })
	expect(app.view().notice).toContain('disk full')
	type('again')
	enter()
	expect(app.view().notice).toBeUndefined()
})

test('a config warning is shown and keeps the transcript', () => {
	app.onEvent(snapshot())
	let before = app.view().transcript
	app.onEvent({ type: 'warning', text: 'config.ason: webPort: bad' })
	expect(app.view().notice).toContain('webPort')
	expect(app.view().transcript).toBe(before)
})

test('losing the host is shown, and cleared on reconnect', () => {
	app.onState({ type: 'disconnected', retryAt: Date.now() + 100 })
	expect(app.view().notice).toBeTruthy()
	app.onState({ type: 'connected', role: 'client' })
	expect(app.view().notice).toBeUndefined()
})

test('Ctrl-D on an empty prompt quits', () => {
	app.onKeys([{ ...key('d'), ctrl: true }])
	expect(quits).toBe(1)
})

test('a sent prompt shows at once, marked pending until acknowledged', () => {
	app.onEvent(snapshot())
	let ids: string[] = []
	drafts.send = (c: any) => (c.type === 'submit' && ids.push(c.id), record(c))
	type('hello')
	enter()
	let rows = () => frame.build(app.view(), 80).lines.map((l) => l.replace(new RegExp(`${'\x1b'}\\[[0-9;]*m`, 'g'), '').trim())
	expect(rows()).toContain('> hello')
	expect(rows().join('\n')).toContain('sending')
	app.onEvent({ type: 'turn-start', sessionId: 's1', prompt: 'hello', provider: 'anthropic' })
	app.onEvent({ type: 'ack', id: ids[0]! })
	expect(rows().filter((r) => r === '> hello')).toHaveLength(1)
	expect(rows().join('\n')).not.toContain('sending')
})

test('typing updates the shared draft; a draft from elsewhere fills the prompt', () => {
	app.onEvent(snapshot('s1', { type: 'idle' }, { text: 'from the phone', rev: 3 }))
	expect(app.view().prompt.text).toBe('from the phone')
	type('!')
	expect(drafted).toEqual([{ type: 'draft', sessionId: 's1', text: 'from the phone!', base: 3 }])
	app.reset()
	app.onEvent(snapshot())
	app.onEvent({ type: 'draft', sessionId: 's1', draft: { text: 'typed elsewhere', rev: 1 } })
	expect(app.view().prompt.text).toBe('typed elsewhere')
})

test('text typed before the session arrives is kept in its draft', () => {
	type('early')
	app.onEvent(snapshot('s1', { type: 'idle' }, { text: 'saved', rev: 1 }))
	expect(app.view().prompt.text).toBe('saved\nearly')
	expect(drafted.at(-1)?.text).toBe('saved\nearly')
})

test('an open question takes the keys until it is answered; the prompt keeps its text', () => {
	app.onEvent(snapshot())
	type('draft')
	let form = { text: 'How should I call you?', fields: [{ type: 'text' as const, name: 'name' }] }
	app.onEvent({ type: 'question', sessionId: 's1', id: 'q1', form })
	app.onEvent({ type: 'state', sessionId: 's1', state: { type: 'blocked', reason: 'question' } })
	type('Dave')
	enter()
	expect(sent).toEqual([{ type: 'answer', sessionId: 's1', question: 'q1', answers: { name: 'Dave' } }])
	expect(app.view().form?.values).toEqual(['Dave'])
	app.onEvent({ type: 'answer', sessionId: 's1', question: 'q1', answers: { name: 'Dave' } })
	app.onEvent({ type: 'state', sessionId: 's1', state: { type: 'running', phase: 'requesting' } })
	expect(app.view().form).toBeUndefined()
	expect(app.view().prompt.text).toBe('draft')
})

test('Escape on an open question pauses the session', () => {
	app.onEvent(snapshot('s1', { type: 'blocked', reason: 'question' }))
	app.onEvent({ type: 'question', sessionId: 's1', id: 'q1', form: { text: 'Go?', fields: [{ type: 'choice', name: 'go', options: ['continue'] }] } })
	escape()
	expect(sent).toEqual([{ type: 'pause', sessionId: 's1' }])
})

test('a modal takes the keys over everything and ends in an ordinary command', () => {
	app.onEvent(snapshot('s1', { type: 'running', phase: 'requesting' }))
	type('draft')
	let search = { text: 'Models', fields: [{ type: 'text' as const, name: 'q', label: 'Search' }] }
	app.open(modals.open({ title: 'Models', form: search, items: ['a', 'b'] }), (action) => ({ type: 'model', sessionId: 's1', item: action.item, q: action.answers.q }))
	expect(app.view().modal?.title).toBe('Models')
	type('op')
	app.onKeys([key('down')])
	enter()
	expect(sent).toEqual([{ type: 'model', sessionId: 's1', item: 1, q: 'op' }])
	expect(app.state.prompt.text).toBe('draft')
	expect(app.view().modal).toBeUndefined()
	// Keys are the prompt's again.
	type('!')
	expect(app.state.prompt.text).toBe('draft!')
})

test('Escape closes a modal and nothing else: the running turn goes on', () => {
	app.onEvent(snapshot('s1', { type: 'running', phase: 'requesting' }))
	app.open(modals.open({ title: 'Models', items: ['a'] }), () => ({ type: 'never' }))
	escape()
	expect(sent).toEqual([])
	expect(app.view().modal).toBeUndefined()
	escape()
	expect(sent).toEqual([{ type: 'pause', sessionId: 's1' }])
})

test('Tab on a command asks the host to complete it; the answer fills the prompt if it is unchanged', () => {
	app.onEvent(snapshot())
	type('hello')
	app.onKeys([key('tab')])
	expect(sent).toEqual([])
	app.onKeys(Array.from({ length: 5 }, () => key('backspace')))
	type('/cd ~/pro')
	app.onKeys([key('tab')])
	expect(sent).toEqual([{ type: 'complete', sessionId: 's1', text: '/cd ~/pro' }])
	app.onEvent({ type: 'completions', sessionId: 's1', text: '/cd ~/pro', items: ['/cd ~/projects/', '/cd ~/projection/'] })
	expect(app.state.prompt).toEqual({ text: '/cd ~/project', cursor: 13 })
	expect(app.view().notice).toContain('projection/')
	expect(drafts.text('s1')).toBe('/cd ~/project')
	// Typed on meanwhile: a late answer is dropped.
	app.onEvent({ type: 'completions', sessionId: 's1', text: '/cd ~/pro', items: ['/cd ~/prof/'] })
	expect(app.state.prompt.text).toBe('/cd ~/project')
})

test('Ctrl-M asks the host for the models; the picker filters as you type and Enter switches', () => {
	app.onEvent(snapshot())
	type('draft')
	app.onKeys([{ ...key('m'), ctrl: true }])
	expect(sent).toEqual([{ type: 'models', sessionId: 's1' }])
	expect(app.view().modal).toBeUndefined()
	let items = ['anthropic/x', 'openrouter/stepfun/step-3.5-flash', 'anthropic/claude-opus-5-5']
	app.onEvent({ type: 'models', sessionId: 's1', current: 'anthropic/x', items })
	expect(app.view().modal?.items).toEqual(items)
	type('opus-5.5')
	expect(app.view().modal?.items).toEqual(['anthropic/claude-opus-5-5'])
	enter()
	expect(sent.at(-1)).toEqual({ type: 'submit', sessionId: 's1', text: '/model anthropic/claude-opus-5-5' })
	expect(app.view().modal).toBeUndefined()
	expect(app.state.prompt.text).toBe('draft')
})

test('a model list for another session opens nothing', () => {
	app.onEvent(snapshot())
	app.onEvent({ type: 'models', sessionId: 's2', current: 'a/b', items: ['a/b'] })
	expect(app.view().modal).toBeUndefined()
})

test('Up moves by the rows the terminal draws, at its width', () => {
	let cols = app.cols
	try {
		app.onEvent(snapshot())
		type('x'.repeat(30))
		app.cols = () => 20
		app.onKeys([key('up')])
		let f = frame.build(app.view(), 20)
		expect(f.cursor.row).toBe(f.lines.length - 2)
		expect(app.view().prompt.cursor).toBe(30 - frame.promptWidth(20))
	} finally {
		app.cols = cols
	}
})

test('an empty prompt shows an example that changes each turn, with its own list for the Hal repo', () => {
	app.onEvent(snapshot())
	let first = app.view().placeholder
	expect(first).toBeTruthy()
	type('hi')
	expect(app.view().placeholder).toBeUndefined()
	enter()
	app.onEvent({ type: 'prompt', sessionId: 's1', texts: ['hi'] })
	expect(app.view().placeholder).not.toBe(first)
	expect(app.view().placeholder).toBe(placeholders.general[1])
	let halDir = app.halDir
	try {
		app.halDir = () => '/'
		expect(app.view().placeholder).toBe(placeholders.hal[1])
	} finally {
		app.halDir = halDir
	}
})

// ── Tabs ──

const tabOf = (id: string, extra: Partial<Tab> = {}): Tab => ({ id, name: id, cwd: `/${id}`, model: 'm', state: { type: 'idle' }, ...extra })
const tabsEvent = (...list: (string | Tab)[]): Event => ({ type: 'tabs', tabs: list.map((t) => (typeof t === 'string' ? tabOf(t) : t)) })
const ctrl = (k: string, shift = false): KeyEvent => ({ key: k, shift, alt: false, ctrl: true, cmd: false })
const alt = (k: string): KeyEvent => ({ key: k, shift: false, alt: true, ctrl: false, cmd: false })
const acked = (tab: string) => app.onEvent({ type: 'ack', id: 'x', tab })
// Starts on tab `a` of `ids`, with its snapshot in.
const startOn = (ids: string[], at = 'a') => {
	app.onEvent(tabsEvent(...ids))
	acked(at)
	app.onEvent(snapshot(at))
	sent = []
}
const shown = () => app.view().tabs?.focused

test('connecting asks the host for the tab to show; its ack focuses and follows it', () => {
	app.state.start = { cwd: '/w', last: 'b' }
	app.onState({ type: 'connected', role: 'host' })
	expect(sent).toEqual([{ type: 'tab-start', cwd: '/w', last: 'b' }])
	app.onEvent(tabsEvent('a', 'b'))
	expect(shown()).toBeUndefined()
	acked('b')
	expect(shown()).toBe('b')
	expect(sent.at(-1)).toEqual({ type: 'open', sessionId: 'b' })
	// A reconnect asks for the tab shown, in its own cwd.
	app.onState({ type: 'connected', role: 'client' })
	expect(sent.at(-1)).toEqual({ type: 'tab-start', cwd: '/b', last: 'b' })
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
	expect(sent.slice(1)).toEqual([
		{ type: 'close', sessionId: 'a' },
		{ type: 'open', sessionId: 'n' },
	])
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
	expect(sent.filter((c) => c.type === 'open').map((c) => c.sessionId)).toEqual(['c', 'a', 'b'])
})

test('each tab keeps its editor state while another is shown; a modal closes on switch', () => {
	startOn(['a', 'b'])
	type('hello')
	app.onKeys([key('left'), key('left')])
	app.onKeys([ctrl('n')])
	expect(app.view().prompt.text).toBe('')
	app.onEvent(snapshot('b'))
	type('x')
	app.open(modals.open({ title: 'Models', items: ['m'] }), () => undefined)
	app.onKeys([ctrl('p')])
	expect(app.view().modal).toBeUndefined()
	expect(app.view().prompt).toMatchObject({ text: 'hello', cursor: 3 })
	// Its transcript shows until the fresh snapshot replaces it.
	expect(app.view().transcript?.meta.id).toBe('a')
	app.onEvent(snapshot('a'))
	expect(app.view().prompt).toMatchObject({ text: 'hello', cursor: 3 })
	app.onKeys([ctrl('n')])
	expect(app.view().prompt.text).toBe('x')
})

test('late events of a tab just left do not reach the view', () => {
	startOn(['a', 'b'])
	app.onKeys([ctrl('n')])
	app.onEvent(snapshot('a', { type: 'running', phase: 'streaming' }))
	expect(app.view().transcript).toBeUndefined()
	app.onEvent(snapshot('b'))
	app.onEvent({ type: 'state', sessionId: 'a', state: { type: 'error', message: 'x' } })
	expect(app.view().transcript?.state).toEqual({ type: 'idle' })
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

test('the tab bar shows the tabs with the focused one', () => {
	startOn(['a', 'b'])
	let lines = frame.build(app.view(), 60).lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''))
	expect(lines.at(-2)).toContain('Tabs: [1] 2 ')
})

// A session that was sent `prompts`, idle again.
function sentBefore(...prompts: string[]) {
	app.onEvent(snapshot())
	for (let prompt of prompts) app.onEvent({ type: 'turn-start', sessionId: 's1', prompt, provider: 'anthropic' })
	app.onEvent({ type: 'state', sessionId: 's1', state: { type: 'idle' } })
}

test('Up and Down browse the prompts sent; the draft stays the text being written', () => {
	sentBefore('first', 'second')
	type('mine')
	drafted = []
	up()
	expect(app.view().prompt).toEqual({ text: 'second', cursor: 6 })
	up()
	expect(app.view().prompt.text).toBe('first')
	// The oldest: Up goes to the start.
	up()
	expect(app.view().prompt).toMatchObject({ text: 'first', cursor: 0 })
	down()
	expect(app.view().prompt.text).toBe('second')
	expect(drafts.text('s1')).toBe('mine')
	down()
	expect(app.view().prompt).toEqual({ text: 'mine', cursor: 4 })
	expect(drafted).toEqual([])
})

test('an edited entry becomes the draft; sending an entry brings the own text back', () => {
	sentBefore('first')
	type('mine')
	up()
	type('!')
	expect(drafts.text('s1')).toBe('first!')
	// Browsing is over: Down stays in the text.
	down()
	expect(app.view().prompt.text).toBe('first!')
	app.onKeys([key('backspace'), key('backspace'), key('backspace'), key('backspace'), key('backspace'), key('backspace')])
	type('mine')
	up()
	enter()
	expect(sent.at(-1)).toEqual({ type: 'submit', sessionId: 's1', text: 'first' })
	expect(app.view().prompt.text).toBe('mine')
	expect(drafts.text('s1')).toBe('mine')
})

test('a draft from elsewhere does not replace a recalled entry but is what Down brings back', () => {
	sentBefore('first')
	up()
	app.onEvent({ type: 'draft', sessionId: 's1', draft: { text: 'web text', rev: 3 } })
	expect(app.view().prompt.text).toBe('first')
	down()
	expect(app.view().prompt.text).toBe('web text')
})

test('the last prompt being edited is skipped by the first Up', () => {
	working('one')
	app.onEvent({ type: 'turn-start', sessionId: 's1', prompt: 'two', provider: 'anthropic' })
	up()
	expect(app.view().prompt.text).toBe('two')
	up()
	expect(app.view().prompt.text).toBe('one')
})

test('Up inside a multi-row prompt moves a row before recalling', () => {
	sentBefore('first')
	type('a')
	app.onKeys([{ ...key('enter'), shift: true }])
	type('b')
	up()
	expect(app.view().prompt).toMatchObject({ text: 'a\nb', cursor: 1 })
	up()
	expect(app.view().prompt.text).toBe('first')
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
	expect(app.view().prompt.text).toBe('first')
	down()
	expect(app.view().prompt.text).toBe('mine')
})

test('Ctrl-L repaints everything', () => {
	let saved = terminal.redraw
	let redraws = 0
	terminal.redraw = () => void redraws++
	try {
		app.onKeys([ctrl('l')])
		expect(redraws).toBe(1)
	} finally {
		terminal.redraw = saved
	}
})

test('output in a tab not shown paints nothing', () => {
	let written = ''
	render.show = saved.show
	render.init({ write: (s) => void (written += s), size: () => ({ rows: 20, cols: 60 }) })
	try {
		startOn(['a', 'b'])
		written = ''
		app.onEvent(snapshot('b', { type: 'running', phase: 'streaming' }))
		app.onEvent({ type: 'state', sessionId: 'b', state: { type: 'error', message: 'x' } })
		expect(written).toBe('')
	} finally {
		render.reset()
	}
})
