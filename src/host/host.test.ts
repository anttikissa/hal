import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { ason } from '../common/ason.ts'
import { blocks, type StreamEvent } from '../common/blocks.ts'
import type { Entry, Event, LiveTurn } from '../common/protocol.ts'
import { host } from './host.ts'
import { liveFiles } from './live-file.ts'
import { sessions } from './sessions.ts'

const savedHome = process.env.HAL_HOME
const origStream = host.stream
const origOnError = liveFiles.onError
let home = ''

// A scripted provider: each call waits for events pushed by the test,
// and ends as cancelled when its signal aborts, like provider.stream.
type Call = { model: string; input: any; push: (...e: StreamEvent[]) => void }
let calls: Call[] = []

function fakeStream(model: string, input: any, signal?: AbortSignal): AsyncIterable<StreamEvent> {
	let queue: StreamEvent[] = []
	let wake = () => {}
	let call: Call = {
		model,
		input,
		push: (...e) => {
			queue.push(...e)
			wake()
		},
	}
	calls.push(call)
	signal?.addEventListener('abort', () => wake())
	return (async function* () {
		while (true) {
			if (signal?.aborted) {
				yield { type: 'error', message: 'Cancelled', cancelled: true }
				return
			}
			let e = queue.shift()
			if (!e) {
				await new Promise<void>((r) => (wake = r))
				continue
			}
			yield e
			if (e.type === 'done' || e.type === 'error') return
		}
	})()
}

beforeEach(() => {
	home = mkdtempSync(`${tmpdir()}/hal-host-`)
	process.env.HAL_HOME = home
	liveFiles.onError = () => {}
	host.stream = fakeStream
	calls = []
})

afterEach(() => {
	host.reset()
	sessions.closeAll()
	host.stream = origStream
	liveFiles.onError = origOnError
	if (savedHome === undefined) delete process.env.HAL_HOME
	else process.env.HAL_HOME = savedHome
	rmSync(home, { recursive: true, force: true })
})

// A client that records events and folds them into what it would show.
function client() {
	let events: Event[] = []
	let views = new Map<string, { history: Entry[]; turn?: LiveTurn }>()
	let conn = host.connect((e) => {
		events.push(e)
		let id = 'sessionId' in e ? e.sessionId : undefined
		let v = id ? views.get(id) : undefined
		if (e.type === 'snapshot') views.set(e.sessionId, structuredClone(e.snapshot))
		else if (!v) return
		else if (e.type === 'turn-start') {
			v.history.push({ type: 'prompt', text: e.prompt })
			v.turn = { provider: e.provider, blocks: [], usage: {} }
		} else if (e.type === 'stream') blocks.apply(v.turn as any, e.event)
		else if (e.type === 'turn-end') {
			if (v.turn?.blocks.length) v.history.push({ type: 'assistant', blocks: v.turn.blocks })
			let end: Entry = { type: 'turn-end', status: e.status }
			if (e.usage) end.usage = e.usage
			if (e.error) end.error = e.error
			v.history.push(end)
			v.turn = undefined
		}
	})
	return { conn, events, views, of: (type: string) => events.filter((e) => e.type === type) as any[] }
}

async function until(check: () => unknown): Promise<void> {
	for (let i = 0; i < 200; i++) {
		if (check()) return
		await new Promise((r) => setTimeout(r, 1))
	}
	throw new Error('timed out')
}

function created(c: ReturnType<typeof client>, cwd = '/tmp/w'): string {
	c.conn.send({ type: 'create', cwd, model: 'fake/m1' })
	let snap = c.of('snapshot').at(-1)
	return snap.sessionId
}

// What a client connecting now would see.
function fresh(id: string) {
	let c = client()
	c.conn.send({ type: 'open', sessionId: id })
	return c.views.get(id)!
}

test('create makes a session and sends its snapshot', () => {
	let a = client()
	let id = created(a, '/tmp/proj')
	let [snap] = a.of('snapshot')
	expect(snap.snapshot.meta).toMatchObject({ id, cwd: '/tmp/proj', model: 'fake/m1' })
	expect(snap.snapshot.history).toEqual([])
	expect(snap.snapshot.turn).toBeUndefined()
	expect(sessions.list().map((s) => s.id)).toEqual([id])
})

test('a completed turn reaches every follower and later snapshots agree', async () => {
	let a = client()
	let id = created(a)
	let b = client()
	b.conn.send({ type: 'open', sessionId: id })
	a.conn.send({ type: 'submit', sessionId: id, text: 'hi' })
	await until(() => calls.length === 1)
	calls[0]!.push({ type: 'thinking', text: 'hmm' }, { type: 'signature', value: 'sig' }, { type: 'text', text: 'hel' })
	calls[0]!.push({ type: 'text', text: 'lo' }, { type: 'usage', usage: { input: 5, output: 2 } }, { type: 'done', reason: 'end' })
	await until(() => b.of('turn-end').length)

	let expected: Entry[] = [
		{ type: 'prompt', text: 'hi' },
		{
			type: 'assistant',
			blocks: [
				{ type: 'thinking', text: 'hmm', signature: 'sig', provider: 'fake' },
				{ type: 'text', text: 'hello' },
			],
		},
		{ type: 'turn-end', status: 'completed', usage: { input: 5, output: 2 } },
	]
	expect(a.views.get(id)!.history).toEqual(expected)
	expect(b.views.get(id)!.history).toEqual(expected)
	expect(fresh(id).history).toEqual(expected)
})

test('provider input is rebuilt from history on each turn', async () => {
	let a = client()
	let id = created(a)
	a.conn.send({ type: 'submit', sessionId: id, text: 'one' })
	await until(() => calls.length === 1)
	calls[0]!.push({ type: 'text', text: 'first' }, { type: 'done', reason: 'end' })
	await until(() => a.of('turn-end').length === 1)
	a.conn.send({ type: 'submit', sessionId: id, text: 'two' })
	await until(() => calls.length === 2)
	expect(calls[1]!.model).toBe('fake/m1')
	expect(calls[1]!.input.messages).toEqual([
		{ role: 'user', blocks: [{ type: 'text', text: 'one' }] },
		{ role: 'assistant', blocks: [{ type: 'text', text: 'first' }] },
		{ role: 'user', blocks: [{ type: 'text', text: 'two' }] },
	])
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
	expect(snap.history).toEqual([{ type: 'prompt', text: 'go' }])
	expect(snap.turn.blocks).toEqual([{ type: 'text', text: 'par' }])

	calls[0]!.push({ type: 'text', text: 'tial' }, { type: 'done', reason: 'end' })
	await until(() => late.of('turn-end').length)
	expect(late.views.get(id)).toEqual(a.views.get(id)!)
	expect(late.views.get(id)!.history[1]).toEqual({ type: 'assistant', blocks: [{ type: 'text', text: 'partial' }] })
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
	await until(() => (again.views.get(id)?.turn?.blocks[0] as any)?.text === 'xy')
	expect(again.views.get(id)!.turn!.blocks).toEqual([{ type: 'text', text: 'xy' }])
	let seen = a.events.length
	calls[0]!.push({ type: 'done', reason: 'end' })
	await until(() => again.of('turn-end').length)
	expect(a.events.length).toBe(seen)
})

test('a submit while a turn runs is rejected to that client only', async () => {
	let a = client()
	let id = created(a)
	let b = client()
	b.conn.send({ type: 'open', sessionId: id })
	a.conn.send({ type: 'submit', sessionId: id, text: 'first' })
	await until(() => calls.length === 1)
	b.conn.send({ type: 'submit', sessionId: id, text: 'second' })
	let [rej] = b.of('rejected')
	expect(rej).toMatchObject({ sessionId: id, command: 'submit' })
	expect(rej.reason).toMatch(/running/)
	expect(a.of('rejected')).toEqual([])
	expect(calls.length).toBe(1)
	calls[0]!.push({ type: 'done', reason: 'end' })
	await until(() => b.of('turn-end').length)
	expect(fresh(id).history.filter((e) => e.type === 'prompt')).toEqual([{ type: 'prompt', text: 'first' }])
})

test('cancel ends the turn as cancelled, keeping partial output', async () => {
	let a = client()
	let id = created(a)
	let b = client()
	b.conn.send({ type: 'open', sessionId: id })
	a.conn.send({ type: 'submit', sessionId: id, text: 'go' })
	await until(() => calls.length === 1)
	calls[0]!.push({ type: 'text', text: 'part' })
	await until(() => a.of('stream').length)
	b.conn.send({ type: 'cancel', sessionId: id })
	await until(() => a.of('turn-end').length)
	expect(a.of('turn-end')[0].status).toBe('cancelled')
	let view = fresh(id)
	expect(view).toEqual(a.views.get(id)!)
	expect(view.history.slice(1)).toEqual([
		{ type: 'assistant', blocks: [{ type: 'text', text: 'part' }] },
		{ type: 'turn-end', status: 'cancelled' },
	])
	// The session takes new prompts afterwards.
	a.conn.send({ type: 'submit', sessionId: id, text: 'again' })
	await until(() => calls.length === 2)
})

test('a provider error ends the turn with the error', async () => {
	let a = client()
	let id = created(a)
	a.conn.send({ type: 'submit', sessionId: id, text: 'go' })
	await until(() => calls.length === 1)
	calls[0]!.push({ type: 'error', message: 'HTTP 500 from fake', status: 500 })
	await until(() => a.of('turn-end').length)
	expect(a.of('turn-end')[0]).toMatchObject({ status: 'error', error: 'HTTP 500 from fake' })
	expect(fresh(id)).toEqual(a.views.get(id)!)
})

test('a stream that throws still ends the turn and frees the session', async () => {
	let a = client()
	let id = created(a)
	host.stream = () => {
		throw new Error('boom')
	}
	a.conn.send({ type: 'submit', sessionId: id, text: 'go' })
	await until(() => a.of('turn-end').length)
	expect(a.of('turn-end')[0]).toMatchObject({ status: 'error', error: 'boom' })
	host.stream = fakeStream
	a.conn.send({ type: 'submit', sessionId: id, text: 'again' })
	await until(() => calls.length === 1)
})

test('bad commands are rejected, not thrown', () => {
	let a = client()
	for (let bad of [null, 'open', { type: 'explode' }, { type: 'submit', sessionId: 1, text: 'x' }, { type: 'create' }]) {
		expect(() => a.conn.send(bad)).not.toThrow()
	}
	a.conn.send({ type: 'open', sessionId: '999-zzz' })
	a.conn.send({ type: 'open', sessionId: '../etc' })
	let id = created(client())
	a.conn.send({ type: 'submit', sessionId: id, text: 'not opened here' })
	a.conn.send({ type: 'cancel', sessionId: id })
	expect(a.of('rejected').length).toBe(9)
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
	late.of('snapshot')[0].snapshot.history.push({ type: 'prompt', text: 'junk' })
	calls[0]!.push({ type: 'done', reason: 'tool_use' })
	await until(() => a.of('turn-end').length)
	for (let e of [...a.events, ...late.events]) expect(ason.parse(ason.stringify(e))).toEqual(e as any)
	expect(fresh(id)).toEqual(a.views.get(id)!)
})
