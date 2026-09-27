import { afterEach, beforeEach, expect, test } from 'bun:test'
import { connection, type LinkState, type Role, type Transport } from './connection.ts'
import type { Event } from './protocol.ts'

// A scripted transport: each attempt takes the next answer (a role, null
// for nobody there, or an error) and records the connection it made.
type FakeConn = { sent: any[]; closed: boolean; deliver: (e: Event) => void; drop: () => void }
let answers: (Role | null | Error)[] = []
let conns: FakeConn[] = []
let events: Event[] = []
let states: LinkState[] = []
let timers: { fn: () => void; ms: number }[] = []
const origSchedule = connection.schedule
const origRandom = connection.random

const transport: Transport = {
	connect: async (on) => {
		let answer = answers.shift() ?? null
		if (answer instanceof Error) throw answer
		if (!answer) return null
		let c: FakeConn = { sent: [], closed: false, deliver: on.event, drop: on.dropped }
		conns.push(c)
		return { role: answer, conn: { send: (command) => c.sent.push(command), close: () => (c.closed = true) } }
	},
}

function snapshot(id: string): Event {
	return { type: 'snapshot', sessionId: id, snapshot: { meta: { id, cwd: '/', model: 'm', createdAt: '' }, history: [], state: { type: 'idle' } } }
}

const start = () => connection.start({ transport, onEvent: (e) => events.push(e), onState: (s) => states.push(s), baseMs: 100, maxMs: 1000 })
const tick = () => Bun.sleep(0)
// The next retry, run now.
async function fire(): Promise<number> {
	let t = timers.shift()!
	t.fn()
	await tick()
	return t.ms
}
const without = (c: any) => {
	let { id: _id, ...rest } = c
	return rest
}

beforeEach(() => {
	answers = []
	conns = []
	events = []
	states = []
	timers = []
	connection.schedule = (fn, ms) => (timers.push({ fn, ms }), 0 as any)
	connection.random = () => 0.5
})

afterEach(() => {
	connection.stop()
	connection.schedule = origSchedule
	connection.random = origRandom
})

test('joining, connected, then disconnected with a retry time until the host is back', async () => {
	answers = ['client']
	await start()
	expect(states).toEqual([{ type: 'joining' }, { type: 'connected', role: 'client' }])
	expect(connection.connected()).toBe(true)
	let before = Date.now()
	conns[0]!.drop()
	await tick()
	expect(connection.connected()).toBe(false)
	let down = states.at(-1) as LinkState & { type: 'disconnected' }
	expect(down.type).toBe('disconnected')
	expect(down.retryAt).toBeGreaterThanOrEqual(before + 100)
	expect(down.retryAt).toBeLessThanOrEqual(Date.now() + 100)
	answers = ['host']
	await fire()
	expect(states.at(-1)).toEqual({ type: 'connected', role: 'host' })
})

test('followed sessions are re-opened on the next connection, closed ones not', async () => {
	answers = ['client', 'client']
	await start()
	for (let id of ['1-a', '2-b', '3-c']) connection.send({ type: 'open', sessionId: id })
	for (let c of conns[0]!.sent) conns[0]!.deliver(snapshot(c.sessionId))
	for (let c of conns[0]!.sent) conns[0]!.deliver({ type: 'ack', id: c.id })
	connection.send({ type: 'close', sessionId: '2-b' })
	conns[0]!.deliver({ type: 'ack', id: conns[0]!.sent.at(-1).id })
	conns[0]!.drop()
	await tick()
	expect(conns[1]!.sent.map(without)).toEqual([
		{ type: 'open', sessionId: '1-a' },
		{ type: 'open', sessionId: '3-c' },
	])
	// A session learned from a snapshot (open-newest, create) is followed too.
	conns[1]!.deliver(snapshot('4-d'))
	expect(connection.state.followed.has('4-d')).toBe(true)
	expect(events.filter((e) => e.type === 'snapshot').length).toBe(4)
})

test('an unanswered command is sent again, with the same id, until the host answers it', async () => {
	answers = ['client', 'client', 'client']
	await start()
	connection.send({ type: 'submit', sessionId: 's', text: 'a' })
	connection.send({ type: 'submit', sessionId: 's', text: 'b' })
	connection.send({ type: 'pause', sessionId: 's' })
	let [a, b, p] = conns[0]!.sent
	expect(new Set([a.id, b.id, p.id]).size).toBe(3)
	conns[0]!.deliver({ type: 'ack', id: a.id })
	conns[0]!.deliver({ type: 'rejected', command: 'pause', reason: 'nothing runs', id: p.id })
	conns[0]!.drop()
	await tick()
	expect(conns[1]!.sent).toEqual([b])
	conns[1]!.drop()
	await tick()
	expect(conns[2]!.sent).toEqual([b])
	conns[2]!.deliver({ type: 'ack', id: b.id })
	expect(connection.state.pending.size).toBe(0)
})

test('commands sent while disconnected go out once, in order, on connecting', async () => {
	answers = ['client']
	await start()
	conns[0]!.drop()
	await tick()
	connection.send({ type: 'submit', sessionId: 's', text: 'one' })
	connection.send({ type: 'submit', sessionId: 's', text: 'two' })
	answers = ['client']
	await fire()
	expect(conns[1]!.sent.map((c) => c.text)).toEqual(['one', 'two'])
})

test('what the client sends on hearing it is connected goes out once', async () => {
	answers = ['client']
	let onState = (s: LinkState) => {
		if (s.type !== 'connected') return
		connection.send({ type: 'tab-start', cwd: '/' })
		connection.send({ type: 'open', sessionId: 's' })
	}
	await connection.start({ transport, onEvent: () => {}, onState, baseMs: 100, maxMs: 1000 })
	expect(conns[0]!.sent.map(without)).toEqual([{ type: 'tab-start', cwd: '/' }, { type: 'open', sessionId: 's' }])
})

test('retries back off, capped, and a connection resets the backoff', async () => {
	answers = ['client']
	await start()
	conns[0]!.drop()
	await tick()
	let waits: number[] = []
	for (let i = 0; i < 6; i++) waits.push(await fire())
	expect(waits).toEqual([100, 200, 400, 800, 1000, 1000])
	answers = ['client']
	await fire()
	conns[1]!.drop()
	await tick()
	expect(timers.at(-1)!.ms).toBe(100)
})

test('a first attempt that throws fails start; later ones just retry', async () => {
	answers = [new Error('bad socket path')]
	expect(start()).rejects.toThrow('bad socket path')
	await tick()
	expect(timers).toEqual([])

	answers = ['client', new Error('flaky'), 'client']
	await start()
	conns[0]!.drop()
	await tick()
	await fire()
	expect(states.at(-1)).toEqual({ type: 'connected', role: 'client' })
})

test('events and drops from a replaced connection are ignored; stop ends retrying', async () => {
	answers = ['client', 'client']
	await start()
	let old = conns[0]!
	old.drop()
	await tick()
	old.deliver(snapshot('x'))
	old.drop()
	await tick()
	expect(events).toEqual([])
	expect(conns.length).toBe(2)
	connection.stop()
	expect(conns[1]!.closed).toBe(true)
	conns[1]!.drop()
	await tick()
	expect(timers).toEqual([])
})

test('an event that fails its check is not applied: the client gets one plain warning naming it', async () => {
	answers = ['client']
	await start()
	connection.send({ type: 'pause', sessionId: 's' })
	let id = conns[0]!.sent[0].id
	events = []
	// A host on newer code: an ack without its id, a draft shaped differently,
	// an event type this client doesn't know, and junk.
	for (let bad of [{ type: 'ack', tab: 3 }, { type: 'draft', sessionId: 's', draft: { text: 1, rev: 0 } }, { type: 'explode', sessionId: 's' }, 'x']) conns[0]!.deliver(bad as any)
	expect(events.map((e) => e.type)).toEqual(['warning', 'warning', 'warning', 'warning'])
	let texts = events.map((e) => (e as any).text as string)
	expect(texts[0]).toContain('ack')
	expect(texts[1]).toContain('draft')
	expect(texts[1]).toContain('draft.text')
	expect(texts[2]).toContain('explode')
	expect(texts.every((t) => /reload|restart/.test(t))).toBe(true)
	// The bad ack answered nothing: the command is still pending.
	expect(connection.state.pending.has(id)).toBe(true)
	events = []
	conns[0]!.deliver({ type: 'ack', id })
	expect(events).toEqual([{ type: 'ack', id }])
	expect(connection.state.pending.has(id)).toBe(false)
})
