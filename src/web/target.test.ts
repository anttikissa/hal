import { afterEach, beforeEach, expect, test } from 'bun:test'
import { connection } from '../common/connection.ts'
import { drafts } from '../common/drafts.ts'
import type { Event } from '../common/protocol.ts'
import type { HistoryRecord } from '../common/replay.ts'
import { app } from './app.ts'
import { router } from './router.ts'
import { target } from './target.ts'
import { view } from './view.ts'

const meta = { id: '1-abc', cwd: '/w', model: 'fake/m', createdAt: '2026-09-26T00:00:00Z' }
const sessionId = meta.id
const ts = '2026-09-26T00:00:01Z'
const long = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n')

// A turn with a tool call whose result is long, numbered from `n`.
const turn = (n: number, text: string): HistoryRecord[] =>
	[
		{ type: 'user', blocks: [{ type: 'text', text }], ts, n },
		{ type: 'assistant', block: { type: 'tool_call', id: `c${n}`, name: 'bash', input: { command: 'seq 40' } }, ts, n: n + 1 },
		{ type: 'user', blocks: [{ type: 'tool_result', id: `c${n}`, output: long }], ts, n: n + 2 },
		{ type: 'turn', status: 'completed', ts, n: n + 3 },
	] as HistoryRecord[]
const early = turn(1, 'first')
const late = turn(5, 'second')

const snapshot = (history: HistoryRecord[], older?: number): Event =>
	({ type: 'snapshot', sessionId, snapshot: { meta, history, state: { type: 'idle' }, ...(older === undefined ? {} : { older }) } }) as Event

let sent: any[] = []
let address = ''
const orig = { send: connection.send, connected: connection.connected, href: router.href, store: drafts.store }

beforeEach(() => {
	sent = []
	app.reset()
	drafts.reset()
	connection.send = (c: any) => void sent.push(c)
	connection.connected = () => true
	drafts.store = { load: () => undefined, save: () => {} }
	app.changed = () => {}
	router.href = () => address
})

afterEach(() => {
	Object.assign(connection, { send: orig.send, connected: orig.connected })
	router.href = orig.href
	drafts.store = orig.store
	drafts.reset()
	app.reset()
})

const rows = () => view.rows(app.state.view.transcript!.items)

test('an address for a block in an earlier page loads that page and finds its card', () => {
	address = `http://h/${sessionId}#3`
	app.aim()
	app.onEvent(snapshot(late, 100))
	expect(sent).toContainEqual({ type: 'history', sessionId, before: 100 })
	expect(app.state.target?.found).toBeUndefined()
	app.onEvent({ type: 'history', sessionId, before: 100, records: early } as Event)
	expect(app.state.target?.found).toBe(true)
	// Block 3 is the first tool result: its card is its call's (block 2).
	expect(target.row(rows(), '3')?.item.key).toBe('2')
})

test('block ids are the same in the tail, in a page, after a reconnect and in a full snapshot', () => {
	app.onEvent(snapshot(late, 100))
	app.older()
	app.onEvent({ type: 'history', sessionId, before: 100, records: early } as Event)
	let paged = app.state.view.transcript!.items.map((i) => i.key)
	app.onEvent(snapshot([...early, ...late]))
	expect(app.state.view.transcript!.items.map((i) => i.key)).toEqual(paged)
	// Every key is linkable and names its own item.
	for (let k of paged) expect(target.parse(`http://h${target.href(sessionId, k)}`, sessionId)).toEqual({ session: sessionId, key: k })
})

test('a block that is in no page gives up with a notice once every page is in', () => {
	address = `http://h/${sessionId}#99`
	app.aim()
	app.onEvent(snapshot(late, 100))
	app.onEvent({ type: 'history', sessionId, before: 100, records: early } as Event)
	expect(app.state.target).toBeUndefined()
	expect(app.notice()).toContain('#99')
	expect(sent.filter((c) => c.type === 'history')).toHaveLength(1)
})
