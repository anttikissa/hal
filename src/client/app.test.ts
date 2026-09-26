import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { Event, Snapshot } from '../common/protocol.ts'
import { app } from './app.ts'
import type { KeyEvent } from './keys.ts'
import { render } from './render.ts'
import { terminal } from './terminal.ts'

// The app with a recording link and renderer: what the user types
// becomes commands, and what the host says becomes the view.

let sent: any[] = []
let quits = 0
const saved = { send: app.send, show: render.show, quit: terminal.quit }

beforeEach(() => {
	sent = []
	quits = 0
	app.reset()
	app.send = (c) => sent.push(c)
	render.show = () => {}
	terminal.quit = () => {
		quits++
	}
})

afterEach(() => {
	Object.assign(app, { send: saved.send })
	render.show = saved.show
	terminal.quit = saved.quit
	app.reset()
})

const snapshot = (id = 's1'): Event => {
	let snap: Snapshot = { meta: { id, cwd: '/', model: 'anthropic/x', createdAt: '' }, history: [] }
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

test('while a turn runs, Enter keeps the text and Escape cancels it', () => {
	app.onEvent(snapshot())
	app.onEvent({ type: 'turn-start', sessionId: 's1', prompt: 'q', provider: 'anthropic' })
	type('next')
	enter()
	expect(sent).toEqual([])
	expect(app.view().prompt.text).toBe('next')
	escape()
	expect(sent).toEqual([{ type: 'cancel', sessionId: 's1' }])
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
	app.onRole(null)
	expect(app.view().notice).toBeTruthy()
	app.onRole('client')
	expect(app.view().notice).toBeUndefined()
})

test('Ctrl-D on an empty prompt quits', () => {
	app.onKeys([{ ...key('d'), ctrl: true }])
	expect(quits).toBe(1)
})
