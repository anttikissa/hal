// The protocol end of the host: connections, snapshots, commands and
// their ids (host.ts).

import { expect, test } from 'bun:test'
import { ason } from '../common/ason.ts'
import { config } from './config.ts'
import { calls, client, created, fresh, records, restartHost, until, useHost, shown } from './host-fixture.test.ts'
import { host } from './host.ts'
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

test('a client connecting mid-turn gets the partial turn, then live events', async () => {
	let a = client()
	let id = created(a)
	a.conn.send({ type: 'submit', sessionId: id, text: 'go' })
	await until(() => calls.length === 1)
	calls[0]!.push({ type: 'text', text: 'par' })
	await until(() => a.of('stream').length === 1)

	let late = client()
	late.conn.send({ type: 'open', sessionId: id })
	let snap = late.of('snapshot')[0].snapshot
	expect(snap.history.map((r: any) => r.type)).toEqual(['user'])
	expect(snap.turn.blocks).toEqual([{ type: 'text', text: 'par' }])

	calls[0]!.push({ type: 'text', text: 'tial' }, { type: 'done', reason: 'end' })
	await until(() => late.of('turn-end').length)
	expect(late.views.get(id)).toEqual(a.views.get(id)!)
	expect(shown(late.views.get(id)!.items)![1]).toEqual({ type: 'text', text: 'partial' })
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
	expect(a.events.every((e) => e.type === 'rejected')).toBe(true)
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

test('open-newest opens the newest session, or creates one in the cwd', async () => {
	let a = client()
	a.conn.send({ type: 'open-newest', cwd: '/tmp/first' })
	let [snap] = a.of('snapshot')
	expect(snap.snapshot.meta.cwd).toBe('/tmp/first')
	let older = snap.sessionId
	let newer = created(a, '/tmp/second')
	let b = client()
	b.conn.send({ type: 'open-newest', cwd: '/tmp/ignored' })
	await until(() => b.of('snapshot').length)
	expect(b.of('snapshot')[0].sessionId).toBe(newer)
	expect(sessions.list().map((s) => s.id).sort()).toEqual([older, newer].sort())
})

test("open-newest without a cwd creates the session in the host's", () => {
	let orig = host.cwd
	host.cwd = () => '/tmp/hostcwd'
	try {
		let a = client()
		a.conn.send({ type: 'open-newest' })
		expect(a.of('snapshot')[0].snapshot.meta.cwd).toBe('/tmp/hostcwd')
	} finally {
		host.cwd = orig
	}
})

test('a command with an id is acknowledged, and a repeat of it never acts twice', async () => {
	let a = client()
	a.conn.send({ type: 'create', cwd: '/tmp/w', model: 'fake/m1', id: 'c1' })
	let id = a.of('snapshot')[0].sessionId
	// The resent create follows the same session again; nothing new.
	let b = client()
	b.conn.send({ type: 'create', cwd: '/tmp/w', model: 'fake/m1', id: 'c1' })
	expect(b.of('snapshot').map((e) => e.sessionId)).toEqual([id])
	expect(sessions.list().length).toBe(1)

	a.conn.send({ type: 'submit', sessionId: id, text: 'once', id: 's1' })
	await until(() => calls.length === 1)
	calls[0]!.push({ type: 'done', reason: 'end' })
	await until(() => a.of('turn-end').length === 1)
	a.conn.send({ type: 'submit', sessionId: id, text: 'once', id: 's1' })
	await Bun.sleep(5)
	expect(calls.length).toBe(1)
	expect((await records(id)).filter((r) => r.type === 'user').length).toBe(1)
	expect(a.of('ack').map((e) => e.id)).toEqual(['c1', 's1', 's1'])
	expect(b.of('ack').map((e) => e.id)).toEqual(['c1'])
	expect(a.of('rejected')).toEqual([])
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
