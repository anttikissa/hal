// Terminal app tests: keys, prompt, modals and the events that drive them.
// Editing, history, tabs and completion have app-<area>.test.ts files.

import { expect, test } from 'bun:test'
import { connection } from '../common/connection.ts'
import { drafts } from '../common/drafts.ts'
import { modals } from '../common/modals.ts'
import type { Event } from '../common/protocol.ts'
import type { Snapshot } from '../common/snapshot.ts'
import { app } from './app.ts'
import { appView } from './app-view.ts'
import { frame } from './frame.ts'
import { keys } from './keys.ts'
import { render } from './render.ts'
import {
	useApp,
	sent,
	drafted,
	watched,
	quits,
	saved,
	snapshot,
	key,
	type,
	enter,
	escape,
	ctrl,
	acked,
	startOn,
} from './app-fixture.test.ts'

useApp()

test('Ctrl-O p loads paste text and replaces markers in the unsent draft', () => {
	app.onEvent(snapshot())
	type('before [paste/abcdef.txt] after')
	app.onKeys([{ ...key('o'), ctrl: true }])
	type('p')
	expect(sent).toContainEqual({ type: 'paste-text', sessionId: 's1', name: 'abcdef.txt' })
	enter()
	expect(app.state.modal).toBeDefined()
	expect(app.state.prompt.text).toBe('before [paste/abcdef.txt] after')
	app.onEvent({ type: 'paste-text', sessionId: 's1', name: 'abcdef.txt', text: 'first\nlast' })
	expect(app.state.modal?.blocks?.hint).toBe('Replace 1 paste marker with their contents (2 lines).')
	enter()
	expect(app.state.modal).toBeUndefined()
	expect(app.state.prompt.text).toBe('before first\nlast after')
	expect(drafts.text('s1')).toBe(app.state.prompt.text)
	expect(sent.some((c) => c.type === 'submit')).toBe(false)
	app.onKeys([{ ...key('/'), ctrl: true }])
	expect(app.state.prompt.text).toBe('before [paste/abcdef.txt] after')
})

test('typing and Enter submits to the open session and clears the prompt', () => {
	app.onEvent(snapshot())
	type('hello')
	enter()
	expect(sent).toEqual([{ type: 'submit', sessionId: 's1', text: 'hello', base: 0 }])
	expect(appView.view().prompt.text).toBe('')
})

test('empty idle Enter sends a nudge despite command output; idle Escape sends nothing', () => {
	app.onEvent(snapshot())
	app.onEvent({ type: 'output', sessionId: 's1', text: 'Directory changed: /work → /project' })
	type('  ')
	enter()
	expect(sent).toHaveLength(1)
	expect(sent[0]).toMatchObject({ type: 'submit', sessionId: 's1' })
	expect(sent[0].text.trim()).not.toBe('')
	expect(appView.view().prompt.text).toBe('')
	escape()
	expect(sent).toHaveLength(1)
})

test('empty Enter on a busy terminal and modified Enter on idle do not nudge', () => {
	app.onEvent(snapshot('s1', { type: 'running', phase: 'streaming' }))
	enter()
	app.onEvent(snapshot())
	app.onKeys([
		{ ...key('enter'), ctrl: true },
		{ ...key('enter'), alt: true },
	])
	expect(sent).toEqual([])
})

test('a submit before any session arrives keeps the text', () => {
	type('early')
	enter()
	expect(sent).toEqual([])
	expect(appView.view().prompt.text).toBe('early')
	expect(appView.view().notice).toBeTruthy()
})

test('while a turn runs, Enter steers, Ctrl-Enter soft-steers, Alt-Enter queues, and Escape pauses', () => {
	app.onEvent(snapshot())
	app.onEvent({ type: 'turn-start', sessionId: 's1', prompt: 'q', provider: 'anthropic' })
	app.onEvent({ type: 'state', sessionId: 's1', state: { type: 'running', phase: 'requesting' } })
	type('now')
	enter()
	expect(appView.view().prompt.text).toBe('')
	type('stop')
	app.onKeys([{ ...key('enter'), ctrl: true }])
	type('later')
	app.onKeys([{ ...key('enter'), alt: true }])
	escape()
	expect(sent).toEqual([
		{ type: 'submit', sessionId: 's1', text: 'now', base: 0 },
		{ type: 'submit', sessionId: 's1', text: 'stop', delivery: 'soft-steer', base: 0 },
		{ type: 'submit', sessionId: 's1', text: 'later', delivery: 'queue', base: 0 },
		{ type: 'pause', sessionId: 's1' },
	])
})

test('waiting messages stay on screen, each once, until delivered', () => {
	app.onEvent(snapshot('s1', { type: 'running', phase: 'streaming' }))
	app.onEvent({
		type: 'inbox',
		sessionId: 's1',
		inbox: [
			{ id: 'a', text: 'steer me' },
			{ id: 'b', text: 'run me later', delivery: 'after-turn' },
		],
	})
	let rows = () =>
		frame.build(appView.view(), 80).lines.map((l) => l.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x07]*\x07/g, '').trim())
	expect(rows().filter((r) => r.includes('steer me'))).toHaveLength(1)
	expect(rows().filter((r) => r.includes('run me later'))).toHaveLength(1)
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
	// Paused. in the transcript and the help row's enter: continue say it all.
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

test('replayed history carries no mark: it reads like one followed live', () => {
	let history: Snapshot['history'] = [
		{ type: 'user', blocks: [{ type: 'text', text: 'old question' }], ts: '2026-09-26T00:50:00Z' },
		{ type: 'turn_end', status: 'error', error: 'overloaded', usage: {}, ts: '2026-09-26T00:51:00Z' },
	]
	app.onEvent({
		type: 'snapshot',
		sessionId: 's1',
		snapshot: { meta: { id: 's1', cwd: '/', model: 'anthropic/x', createdAt: '' }, history, state: { type: 'idle' } },
	})
	app.onEvent({ type: 'turn-start', sessionId: 's1', prompt: 'new question', provider: 'anthropic' })
	let rows = frame
		.build(appView.view(), 80)
		.lines.map((l) => l.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x07]*\x07/g, '').trim())
		.filter(Boolean)
	let at = (s: string) => rows.findIndex((r) => r.includes(s))
	expect(at('error: overloaded')).toBeLessThan(at('new question'))
	expect(rows.join('\n')).not.toMatch(/resumed|last turn/)
	// A client that followed the same session live draws the same lines.
	let live = frame.build(appView.view(), 80).lines
	app.reset()
	app.onEvent({
		type: 'snapshot',
		sessionId: 's1',
		snapshot: {
			meta: { id: 's1', cwd: '/', model: 'anthropic/x', createdAt: '' },
			history: [],
			state: { type: 'idle' },
		},
	})
	for (let e of [
		{ type: 'turn-start', sessionId: 's1', prompt: 'old question', provider: 'anthropic', ts: '2026-09-26T00:50:00Z' },
		{ type: 'turn-end', sessionId: 's1', status: 'error', error: 'overloaded', ts: '2026-09-26T00:51:00Z' },
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

// Invariant (bug fix): a starting client never says the host was lost.
test('joining says nothing before the first join; losing the host is shown, and cleared on reconnect', () => {
	connection.state.joined = false
	app.onState({ type: 'joining' })
	expect(appView.view().notice).toBeUndefined()
	connection.state.joined = true
	app.onState({ type: 'disconnected', retryAt: Date.now() + 100 })
	expect(appView.view().notice).toBe('host lost; reconnecting…')
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
	app.onEvent({
		type: 'question',
		sessionId: 's1',
		id: 'q1',
		form: { text: 'Go?', fields: [{ type: 'choice', name: 'go', options: ['continue'] }] },
	})
	escape()
	expect(sent).toEqual([{ type: 'pause', sessionId: 's1' }])
})

test('a modal takes the keys over everything and ends in an ordinary command', () => {
	app.onEvent(snapshot('s1', { type: 'running', phase: 'requesting' }))
	type('draft')
	let search = { text: 'Models', fields: [{ type: 'text' as const, name: 'q', label: 'Search' }] }
	app.open(modals.open({ title: 'Models', form: search, items: ['a', 'b'] }), (action) => ({
		type: 'model',
		sessionId: 's1',
		item: action.item,
		q: action.answers.q,
	}))
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

test('Ctrl-L repaints everything', () => {
	let saved = render.request
	let redraws = 0
	render.request = (full) => void (full && redraws++)
	try {
		app.onKeys([ctrl('l')])
		expect(redraws).toBe(1)
	} finally {
		render.request = saved
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
	app.onEvent({
		type: 'snapshot',
		sessionId: 's1',
		snapshot: {
			meta: { id: 's1', cwd: '/w', model: 'anthropic/claude-opus-5-5', createdAt: '', name: 'Fix it', slots: 3 },
			history: [],
			state: { type: 'idle' },
			stats: { window: 200_000 },
		},
	})
	let rows = () =>
		frame.build(appView.view(), 100).lines.map((l) => l.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x07]*\x07/g, '').trim())
	let status = () => rows().at(-2)!
	expect(rows().at(-3)).toMatch(/^─+$/)
	expect(status()).toStartWith('s1: Fix it · /w · Opus 5.5 ⣄ · 0/200k (0%)')
	app.onEvent({ type: 'turn-start', sessionId: 's1', prompt: 'go', provider: 'anthropic' })
	app.onEvent({ type: 'turn-end', sessionId: 's1', status: 'completed', stats: { context: 50_000, window: 200_000 } })
	expect(status()).toContain('50k/200k (25%)')
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
