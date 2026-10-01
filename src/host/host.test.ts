// The protocol end of the host: connections, snapshots, commands and
// their ids (host.ts).

import { expect, test } from 'bun:test'
import { ason } from '../common/ason.ts'
import { config } from './config.ts'
import { calls, client, created, fresh, records, restartHost, until, useHost } from './host-fixture.test.ts'
import { history } from './history.ts'
import { host } from './host.ts'
import { pages } from './pages.ts'
import { sessions } from './sessions.ts'

useHost()

test('create makes a session and sends its snapshot', () => {
	let a = client()
	let id = created(a, '/tmp/proj')
	let [snap] = a.of('snapshot')
	expect(snap.snapshot.meta).toMatchObject({ id, cwd: '/tmp/proj', model: 'fake/m1' })
	expect(snap.snapshot.history).toEqual([])
	expect(snap.snapshot.turn).toBeUndefined()
	expect(sessions.list().map((s) => s.id)).toEqual([id])
})

test('reconnecting is connecting again: the snapshot carries the running turn', async () => {
	let a = client()
	let id = created(a)
	a.conn.send({ type: 'submit', sessionId: id, text: 'go' })
	await until(() => calls.length === 1)
	calls[0]!.push({ type: 'text', text: 'x' })
	await until(() => a.of('stream').length === 1)
	a.conn.close()
	calls[0]!.push({ type: 'text', text: 'y' })
	let again = client()
	again.conn.send({ type: 'open', sessionId: id })
	await until(() => (again.views.get(id)?.live?.turn.blocks[0] as any)?.text === 'xy')
	expect(again.views.get(id)!.live!.turn.blocks).toEqual([{ type: 'text', text: 'xy' }])
	let seen = a.events.length
	calls[0]!.push({ type: 'done', reason: 'end' })
	await until(() => again.of('turn-end').length)
	expect(a.events.length).toBe(seen)
})

test('a snapshot read in slices misses no record appended meanwhile, and commands sent after the open wait for it', async () => {
	let a = client()
	let id = created(a)
	for (let i = 0; i < 30; i++) history.append(id, { type: 'output', text: `out ${i}` })
	let saved = { sliceMs: pages.sliceMs, syncBytes: pages.syncBytes, budget: pages.budget, pageSteps: pages.pageSteps }
	pages.sliceMs = () => 0
	pages.syncBytes = () => 0
	pages.budget = () => 300
	// The record lands once the tail has been read, before it is sent.
	pages.pageSteps = function* (...args) {
		let page = yield* saved.pageSteps(...args)
		if (args[1] === undefined) history.append(id, { type: 'output', text: 'meanwhile' })
		return page
	}
	try {
		let b = client()
		b.conn.send({ type: 'open', sessionId: id, id: 'o1' })
		b.conn.send({ type: 'submit', sessionId: id, text: 'go', id: 's1' })
		expect(b.of('snapshot')).toEqual([])
		await until(() => calls.length === 1)
		let [snap] = b.of('snapshot')
		let outputs = (records: any[]) => records.filter((r) => r.type === 'output').map((r) => r.text)
		expect(outputs(snap.snapshot.history).at(-1)).toBe('meanwhile')
		expect(b.of('rejected')).toEqual([])
		expect(b.events.map((e) => (e.type === 'ack' ? e.id : e.type)).filter((t) => ['snapshot', 'o1', 's1'].includes(t))).toEqual(['snapshot', 'o1', 's1'])
		// Earlier pages are answered in slices too, every record once.
		let got = outputs(snap.snapshot.history)
		for (let before = snap.snapshot.older; before !== undefined; ) {
			b.conn.send({ type: 'history', sessionId: id, before })
			await until(() => b.of('history').at(-1)?.before === before)
			let page = b.of('history').at(-1)
			got = [...outputs(page.records), ...got]
			before = page.older
		}
		expect(got).toEqual([...Array.from({ length: 30 }, (_, i) => `out ${i}`), 'meanwhile'])
	} finally {
		Object.assign(pages, saved)
	}
})

// ── Talking while it works: the inbox (tasks/j1/states.md) ──

test('bad commands are rejected, not thrown', async () => {
	let a = client()
	for (let bad of [null, 'open', { type: 'explode' }, { type: 'submit', sessionId: 1, text: 'x' }, { type: 'create' }, { type: 'submit', sessionId: 's', text: 'x', queue: 'yes' }]) {
		expect(() => a.conn.send(bad)).not.toThrow()
	}
	a.conn.send({ type: 'open', sessionId: '999-zzz' })
	a.conn.send({ type: 'open', sessionId: '../etc' })
	let id = created(client())
	a.conn.send({ type: 'submit', sessionId: id, text: 'not opened here' })
	a.conn.send({ type: 'pause', sessionId: id })
	await until(() => a.of('rejected').length === 10)
	expect(a.events.every((e) => e.type === 'rejected' || e.type === 'tabs')).toBe(true)
	expect(calls).toEqual([])
})

test('close stops events for that session only', async () => {
	let a = client()
	let one = created(a)
	let two = created(a)
	a.conn.send({ type: 'close', sessionId: one })
	let b = client()
	b.conn.send({ type: 'open', sessionId: one })
	b.conn.send({ type: 'submit', sessionId: one, text: 'x' })
	a.conn.send({ type: 'submit', sessionId: two, text: 'y' })
	await until(() => calls.length === 2)
	expect(a.events.filter((e) => 'sessionId' in e && e.sessionId === one && e.type !== 'snapshot')).toEqual([])
	expect(a.of('turn-start').map((e) => e.sessionId)).toEqual([two])
})

test('every event is plain data that survives ASON and is not shared', async () => {
	let a = client()
	let id = created(a)
	a.conn.send({ type: 'submit', sessionId: id, text: 'go' })
	await until(() => calls.length === 1)
	calls[0]!.push({ type: 'text', text: 'a' }, { type: 'tool_call', id: 't1', name: 'bash', input: { cmd: 'ls' } })
	await until(() => a.of('stream').length === 2)
	let late = client()
	late.conn.send({ type: 'open', sessionId: id })
	// Mutating what a client received must not reach the host.
	late.of('snapshot')[0].snapshot.turn.blocks.push({ type: 'text', text: 'junk' })
	late.of('snapshot')[0].snapshot.history.push({ type: 'user', blocks: [{ type: 'text', text: 'junk' }], ts: '' })
	calls[0]!.push({ type: 'done', reason: 'tool_use' })
	await until(() => calls.length === 2)
	calls[1]!.push({ type: 'done', reason: 'end' })
	await until(() => a.of('turn-end').length)
	for (let e of [...a.events, ...late.events]) expect(ason.parse(ason.stringify(e))).toEqual(e as any)
	expect(await fresh(id)).toEqual(a.views.get(id)!)
})

// ── Tools ──

test('config warnings reach every client: on connect and when announced', () => {
	let origWarnings = config.warnings
	let current: string[] = []
	config.warnings = () => current
	try {
		let quiet = client()
		expect(quiet.of('warning')).toEqual([])
		current = ['config.ason: webPort: bad']
		let late = client()
		expect(late.of('warning').map((e) => e.text)).toEqual(['config.ason: webPort: bad'])
		host.warnAll()
		expect(quiet.of('warning').map((e) => e.text)).toEqual(['config.ason: webPort: bad'])
		expect(late.of('warning').length).toBe(2)
		current = []
		host.warnAll()
		expect(quiet.of('warning').length).toBe(1)
	} finally {
		config.warnings = origWarnings
	}
})



test('a refused command is rejected with its id, again when repeated', async () => {
	let a = client()
	let id = created(a)
	a.conn.send({ type: 'pause', sessionId: id, id: 'p1' })
	a.conn.send({ type: 'pause', sessionId: id, id: 'p1' })
	expect(a.of('rejected').map((e) => [e.id, e.command])).toEqual([
		['p1', 'pause'],
		['p1', 'pause'],
	])
	expect(a.of('ack')).toEqual([])
})

test('a submit resent to the next host after a restart is not submitted again', async () => {
	let a = client()
	let id = created(a)
	a.conn.send({ type: 'submit', sessionId: id, text: 'once', id: 's1' })
	await until(() => calls.length === 1)
	// The host goes away before the client hears the ack.
	restartHost()
	calls.length = 0
	let b = client()
	b.conn.send({ type: 'open', sessionId: id })
	await until(() => b.of('snapshot').length)
	b.conn.send({ type: 'submit', sessionId: id, text: 'once', id: 's1' })
	expect(b.of('ack').map((e) => e.id)).toEqual(['s1'])
	expect((await records(id)).filter((r) => r.type === 'user').length).toBe(1)
	expect(calls).toEqual([])
})
