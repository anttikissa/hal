import { afterEach, beforeEach, expect, test } from 'bun:test'
import { connection } from '../common/connection.ts'
import { drafts, type Local } from '../common/drafts.ts'
import { modals } from '../common/modals.ts'
import { placeholders } from '../common/placeholders.ts'
import type { Event, Snapshot, Tab } from '../common/protocol.ts'
import type { SessionState } from '../common/states.ts'
import { strings } from '../common/strings.ts'
import { ansi } from './ansi.ts'
import { app } from './app.ts'
import { appView } from './app-view.ts'
import { frame } from './frame.ts'
import { keys, type KeyEvent } from './keys.ts'
import { render } from './render.ts'
import { terminal } from './terminal.ts'

// The app with a recording link and renderer: what the user types
// becomes commands, and what the host says becomes the view.

// Commands as sent, ids left out; draft updates are in `drafted`,
// visibility reports in `watched`.
let sent: any[] = []
let drafted: any[] = []
let watched: any[] = []
let quits = 0
const saved = { send: app.send, show: render.show, quit: terminal.quit, draftSend: drafts.send }
const wasConnected = connection.connected
const record = (c: any) => {
	let { id: _id, ...rest } = c
	if (c.type === 'draft') drafted.push(rest)
	else if (c.type === 'visibility') watched.push(rest)
	else sent.push(rest)
}

beforeEach(() => {
	sent = []
	drafted = []
	watched = []
	quits = 0
	app.reset()
	app.send = record
	connection.connected = () => true
	drafts.send = record
	render.show = () => {}
	terminal.quit = () => {
		quits++
	}
})

afterEach(() => {
	Object.assign(app, { send: saved.send })
	connection.connected = wasConnected
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
	expect(appView.view().prompt.text).toBe('')
})

test('an empty prompt is not submitted; idle Escape sends nothing', () => {
	app.onEvent(snapshot())
	type('  ')
	enter()
	escape()
	expect(sent).toEqual([])
})

test('a submit before any session arrives keeps the text', () => {
	type('early')
	enter()
	expect(sent).toEqual([])
	expect(appView.view().prompt.text).toBe('early')
	expect(appView.view().notice).toBeTruthy()
})

test('while a turn runs, Enter steers it, Alt-Enter queues, and Escape pauses it', () => {
	app.onEvent(snapshot())
	app.onEvent({ type: 'turn-start', sessionId: 's1', prompt: 'q', provider: 'anthropic' })
	app.onEvent({ type: 'state', sessionId: 's1', state: { type: 'running', phase: 'requesting' } })
	type('now')
	enter()
	expect(appView.view().prompt.text).toBe('')
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
	let rows = () => frame.build(appView.view(), 80).lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trim())
	let steer = rows().find((r) => r.includes('steer me'))!
	let later = rows().find((r) => r.includes('run me later'))!
	expect(steer).not.toBe(later)
	expect(steer.replace('steer me', '')).not.toBe(later.replace('run me later', ''))
	// Drawn as the prompts they will become, kind first.
	expect(steer).toBe('(steering) > steer me')
	expect(later).toBe('(queued) > run me later')
	app.onEvent({ type: 'state', sessionId: 's1', state: { type: 'paused' } })
	expect(rows().join('\n')).toMatch(/paused/)
	app.onEvent({ type: 'inbox', sessionId: 's1', inbox: [] })
	expect(rows().join('\n')).not.toContain('steer me')
})

test('Escape pauses a turn another host is carrying on, too', () => {
	app.onEvent(snapshot('s1', { type: 'running', phase: 'requesting' }))
	escape()
	expect(sent).toEqual([{ type: 'pause', sessionId: 's1' }])
})

test('the activity says what the session does, and waiting for answer on a question', () => {
	app.onEvent(snapshot('s1', { type: 'running', phase: 'requesting' }))
	expect(appView.view().activity).toBe('processing')
	app.onEvent({ type: 'state', sessionId: 's1', state: { type: 'blocked', reason: 'question' } })
	expect(appView.view().activity).toBe('waiting for answer')
	app.onEvent({ type: 'state', sessionId: 's1', state: { type: 'idle' } })
	expect(appView.view().activity).toBeUndefined()
	// A login block says so in a word; the whole message is the notice.
	app.onEvent(snapshot('s1', { type: 'blocked', reason: 'log in: token refresh failed: HTTP 400 invalid_grant' }))
	expect(appView.view().activity).toBe('blocked: log in')
	expect(appView.view().why).toContain('invalid_grant')
})

test('bare Enter continues a paused or failed turn, and says so', () => {
	app.onEvent(snapshot('s1', { type: 'paused' }))
	expect(appView.view().activity).toBe('paused')
	// [paused] in the transcript and the help row's enter: continue say it all.
	expect(appView.view().why).toBeUndefined()
	app.onEvent(snapshot('s1', { type: 'paused', reason: 'reached 200 rounds' }))
	expect(appView.view().why).toBe('reached 200 rounds')
	enter()
	app.onEvent({ type: 'state', sessionId: 's1', state: { type: 'error', message: '400 nope' } })
	// The rule says it in a word; the notice has the whole message.
	expect(appView.view().activity).toBe('error')
	expect(appView.view().why).toMatch(/400 nope.*Enter/)
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
	expect(appView.view().prompt).toEqual({ text: 'fix ti', cursor: 6 })
	expect(appView.view().editing).toMatch(/editing/)
	paused()
	app.onKeys([key('backspace'), key('backspace'), key('i', 'i'), key('t', 't')])
	enter()
	expect(sent.at(-1)).toEqual({ type: 'submit', sessionId: 's1', text: 'fix it', amend: true })
	expect(appView.view().prompt.text).toBe('')
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
	expect(appView.view().prompt.text).toBe('')
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
	expect(appView.view().prompt.text).toBe('fix ti!')
	expect(appView.view().editing).toBeUndefined()
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
	expect(appView.view().editing).toBeUndefined()
})

test('replayed history carries no mark: it reads like one followed live', () => {
	let history: Snapshot['history'] = [
		{ type: 'user', blocks: [{ type: 'text', text: 'old question' }], ts: '2026-09-26T00:50:00Z' },
		{ type: 'turn_end', status: 'error', error: 'overloaded', usage: {}, ts: '2026-09-26T00:51:00Z' },
	]
	app.onEvent({ type: 'snapshot', sessionId: 's1', snapshot: { meta: { id: 's1', cwd: '/', model: 'anthropic/x', createdAt: '' }, history, state: { type: 'idle' } } })
	app.onEvent({ type: 'turn-start', sessionId: 's1', prompt: 'new question', provider: 'anthropic' })
	let rows = frame.build(appView.view(), 80).lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trim()).filter(Boolean)
	let at = (s: string) => rows.findIndex((r) => r.includes(s))
	expect(at('error: overloaded')).toBeLessThan(at('new question'))
	expect(rows.join('\n')).not.toMatch(/resumed|last turn/)
	// A client that followed the same session live draws the same lines.
	let live = frame.build(appView.view(), 80).lines
	app.reset()
	app.onEvent({ type: 'snapshot', sessionId: 's1', snapshot: { meta: { id: 's1', cwd: '/', model: 'anthropic/x', createdAt: '' }, history: [], state: { type: 'idle' } } })
	for (let e of [
		{ type: 'turn-start', sessionId: 's1', prompt: 'old question', provider: 'anthropic', ts: '2026-09-26T00:50:00Z' },
		{ type: 'turn-end', sessionId: 's1', status: 'error', error: 'overloaded' },
		{ type: 'turn-start', sessionId: 's1', prompt: 'new question', provider: 'anthropic' },
	] as Event[])
		app.onEvent(e)
	expect(frame.build(appView.view(), 80).lines).toEqual(live)
})

test('a refused command is shown until the next submit', () => {
	app.onEvent(snapshot())
	app.onEvent({ type: 'rejected', sessionId: 's1', command: 'submit', reason: 'disk full' })
	expect(appView.view().notice).toContain('disk full')
	type('again')
	enter()
	expect(appView.view().notice).toBeUndefined()
})

test('a config warning is shown and keeps the transcript', () => {
	app.onEvent(snapshot())
	let before = appView.view().transcript
	app.onEvent({ type: 'warning', text: 'config.ason: webPort: bad' })
	expect(appView.view().notice).toContain('webPort')
	expect(appView.view().transcript).toBe(before)
})

test('losing the host is shown, and cleared on reconnect', () => {
	app.onState({ type: 'disconnected', retryAt: Date.now() + 100 })
	expect(appView.view().notice).toBeTruthy()
	app.onState({ type: 'connected', role: 'client' })
	expect(appView.view().notice).toBeUndefined()
})

test('Ctrl-D on an empty prompt quits', () => {
	app.onKeys([{ ...key('d'), ctrl: true }])
	expect(quits).toBe(1)
})

test('typing updates the shared draft; a draft from elsewhere fills the prompt', () => {
	app.onEvent(snapshot('s1', { type: 'idle' }, { text: 'from the phone', rev: 3 }))
	expect(appView.view().prompt.text).toBe('from the phone')
	type('!')
	expect(drafted).toEqual([{ type: 'draft', sessionId: 's1', text: 'from the phone!', base: 3 }])
	app.reset()
	app.onEvent(snapshot())
	app.onEvent({ type: 'draft', sessionId: 's1', draft: { text: 'typed elsewhere', rev: 1 } })
	expect(appView.view().prompt.text).toBe('typed elsewhere')
})

test('an open question takes the keys until it is answered; the prompt keeps its text', () => {
	app.onEvent(snapshot())
	type('draft')
	let form = { text: 'How should I call you?', fields: [{ type: 'text' as const, name: 'name' }] }
	app.onEvent({ type: 'question', sessionId: 's1', id: 'q1', form })
	app.onEvent({ type: 'state', sessionId: 's1', state: { type: 'blocked', reason: 'question' } })
	// The question is all it shows: no status naming the state.
	expect(appView.view().why).toBeUndefined()
	expect(appView.view().notice).toBeUndefined()
	type('Dave')
	enter()
	expect(sent).toEqual([{ type: 'answer', sessionId: 's1', question: 'q1', answers: { name: 'Dave' } }])
	expect(appView.view().form?.values).toEqual(['Dave'])
	app.onEvent({ type: 'answer', sessionId: 's1', question: 'q1', answers: { name: 'Dave' } })
	app.onEvent({ type: 'state', sessionId: 's1', state: { type: 'running', phase: 'requesting' } })
	expect(appView.view().form).toBeUndefined()
	expect(appView.view().prompt.text).toBe('draft')
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
	expect(appView.view().modal?.title).toBe('Models')
	type('op')
	app.onKeys([key('down')])
	enter()
	expect(sent).toEqual([{ type: 'model', sessionId: 's1', item: 1, q: 'op' }])
	expect(app.state.prompt.text).toBe('draft')
	expect(appView.view().modal).toBeUndefined()
	// Keys are the prompt's again.
	type('!')
	expect(app.state.prompt.text).toBe('draft!')
})

test('Escape closes a modal and nothing else: the running turn goes on', () => {
	app.onEvent(snapshot('s1', { type: 'running', phase: 'requesting' }))
	app.open(modals.open({ title: 'Models', items: ['a'] }), () => ({ type: 'never' }))
	escape()
	expect(sent).toEqual([])
	expect(appView.view().modal).toBeUndefined()
	escape()
	expect(sent).toEqual([{ type: 'pause', sessionId: 's1' }])
})

test('Tab on a command asks the host to complete it; the answer fills the prompt if it is unchanged', () => {
	app.onEvent(snapshot())
	type('hello')
	app.onKeys([key('tab')])
	expect(sent).toEqual([])
	// Elsewhere it is a literal tab.
	expect(app.state.prompt.text).toBe('hello\t')
	app.onKeys(Array.from({ length: 6 }, () => key('backspace')))
	type('/cd ~/pro')
	app.onKeys([key('tab')])
	expect(sent).toEqual([{ type: 'complete', sessionId: 's1', text: '/cd ~/pro' }])
	app.onEvent({ type: 'completions', sessionId: 's1', text: '/cd ~/pro', items: ['/cd ~/projects/', '/cd ~/projection/'] })
	expect(app.state.prompt).toMatchObject({ text: '/cd ~/project', cursor: 13 })
	expect(drafts.text('s1')).toBe('/cd ~/project')
	// Typed on meanwhile: a late answer is dropped.
	app.onEvent({ type: 'completions', sessionId: 's1', text: '/cd ~/pro', items: ['/cd ~/prof/'] })
	expect(app.state.prompt.text).toBe('/cd ~/project')
})

test("completion leaves other notices alone and never uncovers the tab's state by clearing one", () => {
	app.onEvent(snapshot('s1', { type: 'error', message: 'no credits' }))
	app.onEvent({ type: 'warning', text: 'Web is on port 9002' })
	let before = [appView.view().why, appView.view().notice]
	expect(before).toEqual([expect.stringContaining('no credits'), 'Web is on port 9002'])
	type('/sta')
	app.onKeys([key('tab')])
	app.onEvent({ type: 'completions', sessionId: 's1', text: '/sta', items: ['/status '] })
	expect([appView.view().why, appView.view().notice]).toEqual(before)
	type('x')
	app.onKeys([key('tab')])
	app.onEvent({ type: 'completions', sessionId: 's1', text: '/status x', items: [] })
	expect(appView.view().notice).toBe('no completions')
	app.onKeys([key('backspace'), key('tab')])
	app.onEvent({ type: 'completions', sessionId: 's1', text: '/status ', items: ['/status '] })
	expect(appView.view().notice).toBeUndefined()
})

test('several completions are listed in the help row until the next key, and Up still recalls history', () => {
	app.onEvent(snapshot())
	type('earlier')
	enter()
	app.onEvent({ type: 'prompt', sessionId: 's1', texts: ['earlier'] })
	type('/cd ~/pro')
	let before = frame.build(appView.view(), 40)
	app.onKeys([key('tab')])
	let names = Array.from({ length: 12 }, (_, i) => `project-${i}/`)
	app.onEvent({ type: 'completions', sessionId: 's1', text: '/cd ~/pro', items: names.map((n) => `/cd ~/${n}`) })
	let f = frame.build(appView.view(), 40)
	// The first names, in order, on the last row; the frame keeps its height.
	let help = f.lines.at(-1)!.replace(/\x1b\[[0-9;]*m/g, '')
	expect(help).toMatch(/project-0\/ +project-1\/ /)
	expect(strings.visLen(f.lines.at(-1)!)).toBeLessThanOrEqual(40)
	expect(f.lines.length).toBe(before.lines.length)
	expect(appView.view().notice).toBeUndefined()
	app.onKeys([key('up')])
	expect(appView.view().choices).toBeUndefined()
	expect(app.state.prompt.text).toBe('earlier')
	let after = frame.build(appView.view(), 40)
	expect(after.lines.join('')).not.toContain('project-')
})

test('Ctrl-M asks the host for the models; the picker filters as you type and Enter switches', () => {
	app.onEvent(snapshot())
	type('draft')
	app.onKeys([{ ...key('m'), ctrl: true }])
	expect(sent).toEqual([{ type: 'models', sessionId: 's1' }])
	expect(appView.view().modal).toBeUndefined()
	let items = ['anthropic/x', 'openrouter/stepfun/step-3.5-flash', 'anthropic/claude-opus-5-5']
	app.onEvent({ type: 'models', sessionId: 's1', current: 'anthropic/x', items })
	let modal = appView.view().modal!
	expect(modal.tree?.rows[modal.selected]?.id).toBe('anthropic/x')
	// Left closes the current model's category: the tree keys reach the picker.
	app.onKeys([key('left')])
	expect(appView.view().modal!.items[appView.view().modal!.selected]).toMatch(/▶ other$/)
	type('opus-5.5')
	expect(appView.view().modal!.items[appView.view().modal!.selected]).toMatch(/anthropic\/claude-opus-5-5$/)
	enter()
	expect(sent.at(-1)).toEqual({ type: 'submit', sessionId: 's1', text: '/model anthropic/claude-opus-5-5' })
	expect(appView.view().modal).toBeUndefined()
	expect(app.state.prompt.text).toBe('draft')
})

test('a model list for another session opens nothing', () => {
	app.onEvent(snapshot())
	app.onEvent({ type: 'models', sessionId: 's2', current: 'a/b', items: ['a/b'] })
	expect(appView.view().modal).toBeUndefined()
})

test('Up moves by the rows the terminal draws, at its width', () => {
	let cols = app.cols
	try {
		app.onEvent(snapshot())
		type('x'.repeat(30))
		app.cols = () => 20
		app.onKeys([key('up')])
		let f = frame.build(appView.view(), 20)
		expect(f.lines[f.cursor.row + 1]).toContain('xx')
		expect(f.lines[f.cursor.row + 2]).toContain('─')
		expect(appView.view().prompt.cursor).toBe(30 - frame.promptWidth(20))
	} finally {
		app.cols = cols
	}
})

test('an empty prompt shows an example that changes each turn, with its own list for the Hal repo', () => {
	app.onEvent(snapshot())
	let first = appView.view().placeholder
	expect(first).toBeTruthy()
	type('hi')
	expect(appView.view().placeholder).toBeUndefined()
	enter()
	app.onEvent({ type: 'prompt', sessionId: 's1', texts: ['hi'] })
	expect(appView.view().placeholder).not.toBe(first)
	expect(appView.view().placeholder).toBe(placeholders.general[1])
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
const shown = () => appView.view().tabs?.focused

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
	expect(appView.view().placeholder).toBe(placeholders.general[0])
	app.onEvent(tabsEvent(tabOf('a', { hal: true }), 'b'))
	expect(appView.view().placeholder).toBe(placeholders.hal[0])
})

test('a saved draft shown on starting is not doubled; text typed before it follows it', () => {
	let store = drafts.store
	let stored = new Map<string, Local>([['a', { text: 'saved', base: 0, dirty: true, sending: [] }]])
	drafts.store = { load: (id) => stored.get(id) && structuredClone(stored.get(id)), save: (id, l) => void stored.set(id, structuredClone(l)) }
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
	expect(sent).toEqual([{ type: 'tab-start', cwd: '/w', last: 'b' }, { type: 'auth', link: true }])
	app.onEvent(tabsEvent('a', 'b'))
	expect(shown()).toBeUndefined()
	acked('b')
	expect(shown()).toBe('b')
	expect(sent.at(-1)).toEqual({ type: 'open', sessionId: 'b' })
	// A reconnect asks for the tab shown, in its own cwd.
	app.onState({ type: 'connected', role: 'client' })
	expect(sent.at(-2)).toEqual({ type: 'tab-start', cwd: '/b', last: 'b' })
})

test('a remote client starts without a cwd (it names nothing there) and its status names the host', () => {
	app.state.start = { last: 'b' }
	app.onState({ type: 'connected', role: 'client' })
	expect(sent[0]).toEqual({ type: 'tab-start', last: 'b' })
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
		expect(targets).toEqual(expect.arrayContaining(['https://h.example/a?auth=k3x9qa', 'https://h.example/b?auth=k3x9qa', 'https://h.example/image/frdbn1.png?auth=k3x9qa']))
		expect(lines.map((l) => l.replace(/\x1b\]8;;[^\x07]*\x07/g, '')).join('\n')).not.toContain('k3x9qa')
		// A history item laid out before the server bound (on another port
		// than the preferred one) links to where it really listens.
		let item = () => frame.build(appView.view(), 60).lines.find((l) => l.includes('#1'))
		expect(item()).toContain('https://h.example/a?auth=k3x9qa#1')
		app.onEvent({ type: 'auth', code: 'k3x9qa', link: 'http://localhost:9003' })
		expect(item()).toContain('http://localhost:9003/a?auth=k3x9qa#1')
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
	// Browsing is over: Down stays in the text.
	down()
	expect(appView.view().prompt.text).toBe('first!')
	app.onKeys([key('backspace'), key('backspace'), key('backspace'), key('backspace'), key('backspace'), key('backspace')])
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
	working('one')
	app.onEvent({ type: 'turn-start', sessionId: 's1', prompt: 'two', provider: 'anthropic' })
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

test('the status row sits below the prompt box and its numbers follow each turn end', () => {
	app.onEvent({ type: 'snapshot', sessionId: 's1', snapshot: { meta: { id: 's1', cwd: '/w', model: 'anthropic/claude-opus-5-5', createdAt: '', name: 'Fix it' }, history: [], state: { type: 'idle' }, stats: { window: 200_000, sent: 0, received: 0 } } })
	let rows = () => frame.build(appView.view(), 100).lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trim())
	let status = () => rows().at(-2)!
	expect(rows().at(-3)).toMatch(/^─+$/)
	expect(status()).toStartWith('s1: Fix it · /w · Opus 5.5 · 0/200k (0%)')
	app.onEvent({ type: 'turn-start', sessionId: 's1', prompt: 'go', provider: 'anthropic' })
	app.onEvent({ type: 'turn-end', sessionId: 's1', status: 'completed', stats: { context: 50_000, window: 200_000, sent: 1234, received: 5678 } })
	expect(status()).toContain('50k/200k (25%)')
	expect(status()).toEndWith('↑1.2k ↓5.7k')
})

test('the terminal watches the tab it shows until its window reports losing focus', () => {
	startOn(['a', 'b'])
	// Never reported focus: showing a tab is watching it.
	expect(watched).toEqual([{ type: 'visibility', sessionId: 'a', visible: true }])
	let decoder = keys.createState()
	app.onKeys(keys.feed(decoder, '\x1b[O'))
	app.onKeys(keys.feed(decoder, '\x1b[O'))
	expect(watched.at(-1)).toEqual({ type: 'visibility', sessionId: 'a', visible: false })
	app.onKeys([ctrl('n')])
	expect(watched.at(-1)).toEqual({ type: 'visibility', sessionId: 'b', visible: false })
	app.onKeys(keys.feed(decoder, '\x1b[I'))
	expect(watched.at(-1)).toEqual({ type: 'visibility', sessionId: 'b', visible: true })
	expect(watched).toHaveLength(4)
	// Focus reports are not keys: the prompt is untouched.
	expect(app.state.prompt.text).toBe('')
	// A new connection's host hears it again.
	app.onState({ type: 'connected', role: 'client' })
	acked('b')
	expect(watched.at(-1)).toEqual({ type: 'visibility', sessionId: 'b', visible: true })
	expect(watched).toHaveLength(5)
})

