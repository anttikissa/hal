import { afterEach, beforeEach, expect, test } from 'bun:test'
import { drafts } from '../common/drafts.ts'
import { modals } from '../common/modals.ts'
import type { Event, Snapshot } from '../common/protocol.ts'
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
	app.onKeys([key('backspace')])
	paused()
	up()
	expect(sent).toEqual([])
	expect(app.view().prompt.text).toBe('')
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
