import { existsSync, readFileSync, statSync } from 'fs'
// The protocol end of the host: connections, snapshots, commands and
// their ids (host.ts).

import { expect, test } from 'bun:test'
import { ason } from '../common/ason.ts'
import type { Event } from '../common/protocol.ts'
import { config } from './config.ts'
import { calls, client, created, fresh, records, restartHost, until, useHost } from './host-fixture.test.ts'
import { history } from './history.ts'
import { warnings } from './warnings.ts'
import { models } from './models.ts'
import { sessions } from './sessions.ts'
import { host } from './host.ts'
import { paths } from './paths.ts'

useHost()

test('web snapshot load diagnostics are opt-in, numeric and content-free', async () => {
	let id = created(client())
	history.append(id, { type: 'user', blocks: [{ type: 'text', text: 'private content' }] })
	let messages: string[] = []
	let web = host.adapt((message) => messages.push(message), { kind: 'web' })
	let file = `${paths.stateDir()}/web-diag.log`
	try {
		web.receive(ason.stringify({ type: 'open', sessionId: id }))
		await until(() => messages.some((m) => (ason.parse(m) as Event).type === 'snapshot'))
		expect(existsSync(file)).toBe(false)
		config.update({ webDiagnostics: true })
		messages.length = 0
		web.receive(ason.stringify({ type: 'open', sessionId: id }))
		await until(() => messages.some((m) => (ason.parse(m) as Event).type === 'snapshot'))
		let logged = readFileSync(file, 'utf8')
		expect(logged).not.toContain(id)
		expect(logged).not.toContain('private content')
		let entries = logged.trim().split('\n').flatMap((line) => JSON.parse(line.slice(line.indexOf(' ') + 1)).entries)
		expect(entries.map((e) => e.detail)).toEqual(['requested', 'ready', 'tail', 'built', 'encoded'])
		expect(entries.every((e) => Number.isFinite(e.ms) && e.ms >= 0)).toBe(true)
		expect(entries.at(-1).bytes).toBeGreaterThan(0)
	} finally { web.close() }
})

test('create makes a session and sends its snapshot', () => {
	let a = client()
	let id = created(a, '/tmp/proj')
	let [snap] = a.of('snapshot')
	expect(snap.snapshot.meta).toMatchObject({ id, cwd: '/tmp/proj', model: 'fake/m1' })
	expect(snap.snapshot.history).toEqual([])
	expect(snap.snapshot.turn).toBeUndefined()
	expect(sessions.list().map((s) => s.id)).toEqual([id])
})

test('history sends distinct assistant model names before the page', async () => {
	let a = client()
	let id = created(a)
	history.append(id, { type: 'assistant', block: { type: 'text', text: 'old' }, model: 'openai/gpt-6-luna' })
	history.append(id, { type: 'assistant', block: { type: 'text', text: 'again' }, model: 'openai/gpt-6-luna' })
	let original = models.nameEvent
	models.nameEvent = (ids) => ids.length ? { type: 'model-names', names: { 'openai/gpt-6-luna': 'GPT-6 Luna' } } : undefined
	try {
		a.events.length = 0
		a.conn.send({ type: 'history', sessionId: id, before: statSync(history.file(id)).size })
		expect(a.events.map((e) => e.type)).toEqual(['model-names', 'history'])
		expect(a.of('model-names')[0].names).toEqual({ 'openai/gpt-6-luna': 'GPT-6 Luna' })
	} finally {
		models.nameEvent = original
	}
})

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
		warnings.all()
		expect(quiet.of('warning').map((e) => e.text)).toEqual(['config.ason: webPort: bad'])
		expect(late.of('warning').length).toBe(2)
		current = []
		warnings.all()
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
