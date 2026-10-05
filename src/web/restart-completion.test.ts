import { afterEach, beforeEach, expect, test } from 'bun:test'
import { connection } from '../common/connection.ts'
import { drafts } from '../common/drafts.ts'
import type { Event } from '../common/protocol.ts'
import { app } from './app.ts'
import { keys } from './keys.ts'
import { router } from './router.ts'
import { restart } from './restart.ts'

const sessionId = 'restart-test'
const items = ['/restart all', '/restart host', '/restart both', '/restart local']
let sent: any[] = []
const original = { send: connection.send, connected: connection.connected, store: drafts.store, href: router.href, write: router.write, changed: app.changed, typed: restart.typed }

beforeEach(() => {
	app.reset()
	drafts.reset()
	sent = []
	connection.send = (command: any) => void sent.push(command)
	connection.connected = () => true
	drafts.store = { load: () => undefined, save() {} }
	router.href = () => 'http://example.com/'
	router.write = () => {}
	app.changed = () => {}
	app.onEvent({ type: 'snapshot', sessionId, snapshot: { meta: { id: sessionId, cwd: '/tmp', model: 'fake/m', createdAt: '2026-10-02T00:00:00Z' }, history: [], state: { type: 'idle' } } } as Event)
})

afterEach(() => {
	connection.send = original.send
	connection.connected = original.connected
	drafts.store = original.store
	router.href = original.href
	router.write = original.write
	restart.typed = original.typed
	app.changed = original.changed
	drafts.reset()
	app.reset()
})

const press = (key: string) => keys.key({ key, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false }, { kind: 'message', text: app.state.text, cursor: app.state.text.length })
const reply = (text: string) => app.onEvent({ type: 'completions', sessionId, text, items, descriptions: ['restart all (default)', 'restart the host', 'restart both', 'restart this client'] })

test('restart Tab fills all before or after suggestions arrive, without submission', () => {
	for (let text of ['/restart', '/restart ']) {
		for (let ready of [false, true]) {
			app.input(text)
			if (ready) {
				reply(text)
				expect(app.state.text).toBe(text)
				expect(app.state.menu?.choices[0]).toMatchObject({ label: 'all', description: 'restart all (default)' })
			}
			expect(press('Tab')).toBe(true)
			if (!ready) reply(text)
			expect(app.state.text).toBe('/restart all')
		}
	}
	expect(sent.some((c) => c.type === 'submit')).toBe(false)
})

test('Tab respects deliberately selected scope and stale replies cannot replace it', () => {
	app.input('/restart')
	reply('/restart')
	press('ArrowDown')
	press('Tab')
	expect(app.state.text).toBe('/restart host')
	reply('/restart')
	expect(app.state.text).toBe('/restart host')
	expect(sent.some((c) => c.type === 'submit')).toBe(false)
})

test('passive restart scopes leave Enter running the original command, like cd', () => {
	let run: string[] = []
	restart.typed = (text) => { run.push(text); return text.trim() === '/restart' }
	for (let text of ['/restart', '/restart ']) {
		app.input(text)
		reply(text)
		expect(press('Enter')).toBe(true)
		expect(run.at(-1)).toBe(text)
		expect(app.state.text).toBe('')
	}
	app.input('/cd')
	app.onEvent({ type: 'completions', sessionId, text: '/cd', items: ['/cd '] })
	press('Enter')
	expect(sent.find((c) => c.type === 'submit')).toMatchObject({ text: '/cd' })
})

test('Tab completes prefixes, not passive highlights, before or after model suggestions arrive', () => {
	let models = ['/model astra', '/model openrouter/openai/gpt-6-astra', '/model openai/gpt-astra-latest']
	let scenarios = [
		{ input: '/model astr', expected: '/model astra', candidates: models },
		{ input: '/model ast', expected: '/model astra', candidates: [...models, '/model astra-pro'] },
		{ input: '/model big', expected: '/model acme/big-', candidates: ['/model acme/big-1', '/model acme/big-2'] },
	]
	for (let ready of [false, true]) {
		for (let { input, expected, candidates } of scenarios) {
			app.input(input)
			let event = { type: 'completions' as const, sessionId, text: input, items: candidates, descriptions: candidates.map((s) => s.slice(7)) }
			if (ready) { app.onEvent(event); expect(app.state.text).toBe(input) }
			press('Tab')
			if (!ready) app.onEvent(event)
			expect(app.state.text).toBe(expected)
			expect(drafts.text(sessionId)).toBe(expected)
			expect(app.state.menu?.choices.map((c) => c.value)).toEqual(candidates)
			app.onEvent(event)
			expect(app.state.text).toBe(expected)
		}
	}
	app.input('/model astr')
	app.onEvent({ type: 'completions', sessionId, text: '/model astr', items: models })
	press('ArrowDown')
	press('Tab')
	expect(app.state.text).toBe(models[1]!)
	expect(app.state.menu).toBeUndefined()
	expect(sent.some((c) => c.type === 'submit')).toBe(false)
})
