import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { ason } from '../common/ason.ts'
import type { StreamEvent } from '../common/blocks.ts'
import type { Event } from '../common/protocol.ts'
import { replay } from '../common/replay.ts'
import { states } from '../common/states.ts'
import { transcript, type Item, type Transcript } from '../common/transcript.ts'
import { config } from './config.ts'
import { history } from './history.ts'
import { host } from './host.ts'
import { liveFiles } from './live-file.ts'
import { sessions } from './sessions.ts'
import { tools } from './tools.ts'

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
	let views = new Map<string, Transcript>()
	let conn = host.connect((e) => {
		events.push(e)
		let id = 'sessionId' in e ? e.sessionId : undefined
		if (id) {
			let t = transcript.fold(views.get(id), e)
			if (t) views.set(id, t)
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
async function fresh(id: string): Promise<Transcript> {
	let c = client()
	c.conn.send({ type: 'open', sessionId: id })
	await until(() => c.views.get(id))
	return c.views.get(id)!
}

// The host process goes away and a new one starts on the same home.
function restartHost() {
	host.reset()
	sessions.closeAll()
	history.state.running.clear()
}

const records = async (id: string) => (await history.read(id)).map(({ ts: _ts, ...r }) => r)

test('create makes a session and sends its snapshot', () => {
	let a = client()
	let id = created(a, '/tmp/proj')
	let [snap] = a.of('snapshot')
	expect(snap.snapshot.meta).toMatchObject({ id, cwd: '/tmp/proj', model: 'fake/m1' })
	expect(snap.snapshot.history).toEqual([])
	expect(snap.snapshot.turn).toBeUndefined()
	expect(sessions.list().map((s) => s.id)).toEqual([id])
})

test('a completed turn reaches every follower and is durable before turn-end', async () => {
	let a = client()
	let id = created(a)
	let b = client()
	b.conn.send({ type: 'open', sessionId: id })
	a.conn.send({ type: 'submit', sessionId: id, text: 'hi' })
	expect(await records(id)).toEqual([{ type: 'user', blocks: [{ type: 'text', text: 'hi' }] }])
	await until(() => calls.length === 1)
	calls[0]!.push({ type: 'thinking', text: 'hmm' }, { type: 'signature', value: 'sig' }, { type: 'text', text: 'hel' })
	calls[0]!.push({ type: 'text', text: 'lo' }, { type: 'usage', usage: { input: 5, output: 2 } }, { type: 'done', reason: 'end' })
	let onDisk: unknown
	let watcher = host.connect((e) => {
		if (e.type === 'turn-end') onDisk = history.readSync(id).map((r) => r.type)
	})
	watcher.send({ type: 'open', sessionId: id })
	await until(() => b.of('turn-end').length)
	expect(onDisk).toEqual(['user', 'assistant', 'assistant', 'turn_end'])

	let expected: Item[] = [
		{ type: 'prompt', text: 'hi' },
		{ type: 'thinking', text: 'hmm' },
		{ type: 'text', text: 'hello' },
		{ type: 'turn-end', status: 'completed', usage: { input: 5, output: 2 } },
	]
	expect(a.views.get(id)!.items).toEqual(expected)
	expect(b.views.get(id)!.items).toEqual(expected)
	expect((await fresh(id)).items).toEqual(expected)
	expect((await records(id)).at(-1)).toEqual({ type: 'turn_end', status: 'completed', reason: 'end', usage: { input: 5, output: 2 } })
})

test('the next turn replays durable history, even after a host restart', async () => {
	let a = client()
	let id = created(a)
	a.conn.send({ type: 'submit', sessionId: id, text: 'one' })
	await until(() => calls.length === 1)
	calls[0]!.push({ type: 'thinking', text: 'why' }, { type: 'signature', value: 'sig' }, { type: 'text', text: 'first' }, { type: 'done', reason: 'end' })
	await until(() => a.of('turn-end').length === 1)
	restartHost()

	let b = client()
	b.conn.send({ type: 'open', sessionId: id })
	await until(() => b.views.get(id))
	expect(b.views.get(id)!.items).toEqual(a.views.get(id)!.items)
	b.conn.send({ type: 'submit', sessionId: id, text: 'two' })
	await until(() => calls.length === 2)
	expect(calls[1]!.model).toBe('fake/m1')
	expect(calls[1]!.input.messages).toEqual([
		{ role: 'user', blocks: [{ type: 'text', text: 'one' }] },
		{
			role: 'assistant',
			blocks: [
				{ type: 'thinking', text: 'why', signature: 'sig', provider: 'fake' },
				{ type: 'text', text: 'first' },
			],
		},
		{ role: 'user', blocks: [{ type: 'text', text: 'two' }] },
	])
})

test('a turn cut off by a host that went away continues on the next host, told what happened', async () => {
	let a = client()
	let id = created(a)
	a.conn.send({ type: 'submit', sessionId: id, text: 'go' })
	await until(() => calls.length === 1)
	calls[0]!.push({ type: 'text', text: 'a' })
	await until(() => a.of('stream').length === 1)
	// The process dies: nothing more is written for this turn.
	history.stop(false)
	restartHost()

	// Until the new host continues it, the turn shows as running.
	let early = await fresh(id)
	expect(early.state).toEqual({ type: 'running', phase: 'requesting' })
	let b = client()
	b.conn.send({ type: 'open', sessionId: id })
	await until(() => b.views.get(id))
	await host.recover()
	await until(() => calls.length === 2)
	expect(calls[1]!.input.messages).toEqual([
		{ role: 'user', blocks: [{ type: 'text', text: 'go' }] },
		{ role: 'assistant', blocks: [{ type: 'text', text: 'a' }] },
		{ role: 'user', blocks: [{ type: 'text', text: replay.continueNote }] },
	])
	calls[1]!.push({ type: 'text', text: 'b' }, { type: 'done', reason: 'end' })
	await until(() => b.of('turn-end').length)
	let expected: Item[] = [
		{ type: 'prompt', text: 'go' },
		{ type: 'text', text: 'a' },
		{ type: 'text', text: 'b' },
		{ type: 'turn-end', status: 'completed' },
	]
	expect(b.views.get(id)!.items).toEqual(expected)
	expect(b.views.get(id)!.state).toEqual({ type: 'idle' })
	expect(await fresh(id)).toEqual(b.views.get(id)!)
	// Nothing is left to continue.
	await host.recover()
	expect(calls.length).toBe(2)
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
	expect(late.views.get(id)!.items[1]).toEqual({ type: 'text', text: 'partial' })
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
	expect((await fresh(id)).items.filter((e) => e.type === 'prompt')).toEqual([{ type: 'prompt', text: 'first' }])
})

test('pause stops the turn, keeping partial output, and continue carries it on', async () => {
	let a = client()
	let id = created(a)
	let b = client()
	b.conn.send({ type: 'open', sessionId: id })
	a.conn.send({ type: 'submit', sessionId: id, text: 'go' })
	await until(() => calls.length === 1)
	calls[0]!.push({ type: 'text', text: 'part' })
	await until(() => a.of('stream').length)
	expect(a.views.get(id)!.state).toEqual({ type: 'running', phase: 'streaming' })
	b.conn.send({ type: 'pause', sessionId: id })
	await until(() => a.of('turn-end').length)
	expect(a.of('turn-end')[0].status).toBe('paused')
	expect(a.views.get(id)!.state).toEqual({ type: 'paused' })
	let view = await fresh(id)
	expect(view).toEqual(a.views.get(id)!)
	expect(view.items.slice(1)).toEqual([
		{ type: 'text', text: 'part' },
		{ type: 'turn-end', status: 'paused' },
	])
	// A new host does not continue a paused turn.
	restartHost()
	await host.recover()
	expect(calls.length).toBe(1)
	a = client()
	a.conn.send({ type: 'open', sessionId: id })
	await until(() => a.views.get(id))
	expect(a.views.get(id)!.state).toEqual({ type: 'paused' })
	a.conn.send({ type: 'continue', sessionId: id })
	await until(() => calls.length === 2)
	expect(calls[1]!.input.messages.at(-1)).toEqual({ role: 'user', blocks: [{ type: 'text', text: replay.continueNote }] })
	calls[1]!.push({ type: 'text', text: 'rest' }, { type: 'done', reason: 'end' })
	await until(() => a.of('turn-end').length)
	expect(a.views.get(id)!.items.slice(1)).toEqual([
		{ type: 'text', text: 'part' },
		{ type: 'turn-end', status: 'paused' },
		{ type: 'text', text: 'rest' },
		{ type: 'turn-end', status: 'completed' },
	])
	expect(await fresh(id)).toEqual(a.views.get(id)!)
})

test('continue is refused with nothing to continue; after an error it retries the request', async () => {
	let a = client()
	let id = created(a)
	a.conn.send({ type: 'continue', sessionId: id })
	expect(a.of('rejected')[0]).toMatchObject({ command: 'continue', reason: expect.stringMatching(/nothing/) })
	a.conn.send({ type: 'pause', sessionId: id })
	expect(a.of('rejected')[1]).toMatchObject({ command: 'pause' })
	a.conn.send({ type: 'submit', sessionId: id, text: 'go' })
	await until(() => calls.length === 1)
	calls[0]!.push({ type: 'error', message: '400 bad request', status: 400 })
	await until(() => a.of('turn-end').length)
	expect(a.views.get(id)!.state).toEqual({ type: 'error', message: '400 bad request' })
	a.conn.send({ type: 'continue', sessionId: id })
	await until(() => calls.length === 2)
	expect(calls[1]!.input.messages).toEqual([{ role: 'user', blocks: [{ type: 'text', text: 'go' }] }])
})

test('a user message to a paused turn goes on from there', async () => {
	let a = client()
	let id = created(a)
	a.conn.send({ type: 'submit', sessionId: id, text: 'go' })
	await until(() => calls.length === 1)
	a.conn.send({ type: 'pause', sessionId: id })
	await until(() => a.of('turn-end').length)
	a.conn.send({ type: 'submit', sessionId: id, text: 'actually' })
	await until(() => calls.length === 2)
	expect(a.views.get(id)!.state.type).toBe('running')
})

test('a provider error ends the turn with the error', async () => {
	let a = client()
	let id = created(a)
	a.conn.send({ type: 'submit', sessionId: id, text: 'go' })
	await until(() => calls.length === 1)
	calls[0]!.push({ type: 'error', message: 'HTTP 500 from fake', status: 500 })
	await until(() => a.of('turn-end').length)
	expect(a.of('turn-end')[0]).toMatchObject({ status: 'error', error: 'HTTP 500 from fake' })
	expect(await fresh(id)).toEqual(a.views.get(id)!)
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
	expect((await records(id)).at(-1)).toMatchObject({ type: 'turn_end', status: 'error', error: 'boom' })
	host.stream = fakeStream
	a.conn.send({ type: 'submit', sessionId: id, text: 'again' })
	await until(() => calls.length === 1)
})

test('bad commands are rejected, not thrown', async () => {
	let a = client()
	for (let bad of [null, 'open', { type: 'explode' }, { type: 'submit', sessionId: 1, text: 'x' }, { type: 'create' }]) {
		expect(() => a.conn.send(bad)).not.toThrow()
	}
	a.conn.send({ type: 'open', sessionId: '999-zzz' })
	a.conn.send({ type: 'open', sessionId: '../etc' })
	let id = created(client())
	a.conn.send({ type: 'submit', sessionId: id, text: 'not opened here' })
	a.conn.send({ type: 'pause', sessionId: id })
	await until(() => a.of('rejected').length === 9)
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

function toolSession(c: ReturnType<typeof client>): string {
	writeFileSync(`${home}/notes.txt`, 'remember the milk\n')
	return created(c, home)
}

const readCall = (id = 't1'): StreamEvent => ({ type: 'tool_call', id, name: 'read', input: { path: 'notes.txt' } })

test('a tool call runs on the host and the turn continues with its result', async () => {
	let a = client()
	let id = toolSession(a)
	let b = client()
	b.conn.send({ type: 'open', sessionId: id })
	a.conn.send({ type: 'submit', sessionId: id, text: 'what did I note?' })
	await until(() => calls.length === 1)
	expect(calls[0]!.input.tools.map((t: any) => t.name)).toContain('read')
	calls[0]!.push({ type: 'text', text: 'Let me look.' }, readCall(), { type: 'usage', usage: { input: 10, output: 5 } }, { type: 'done', reason: 'tool_use' })
	await until(() => calls.length === 2)
	expect(calls[1]!.input.messages.slice(1)).toEqual([
		{
			role: 'assistant',
			blocks: [
				{ type: 'text', text: 'Let me look.' },
				{ type: 'tool_call', id: 't1', name: 'read', input: { path: 'notes.txt' } },
			],
		},
		{ role: 'user', blocks: [{ type: 'tool_result', id: 't1', output: 'remember the milk\n' }] },
	])
	// Still one turn: nobody has seen it end.
	expect(a.of('turn-end')).toEqual([])
	let late = client()
	late.conn.send({ type: 'open', sessionId: id })
	calls[1]!.push({ type: 'text', text: 'Milk.' }, { type: 'usage', usage: { input: 20, output: 1 } }, { type: 'done', reason: 'end' })
	await until(() => b.of('turn-end').length && late.of('turn-end').length)

	let view = await fresh(id)
	expect(view.items).toEqual([
		{ type: 'prompt', text: 'what did I note?' },
		{ type: 'text', text: 'Let me look.' },
		{ type: 'tool', id: 't1', name: 'read', input: { path: 'notes.txt' } },
		{ type: 'tool-result', id: 't1', output: 'remember the milk\n' },
		{ type: 'text', text: 'Milk.' },
		{ type: 'turn-end', status: 'completed', usage: { input: 30, output: 6 } },
	])
	expect(a.views.get(id)).toEqual(view)
	expect(b.views.get(id)).toEqual(view)
	expect(late.views.get(id)).toEqual(view)
	expect((await records(id)).filter((r) => r.type === 'turn_end')).toHaveLength(1)
})

test('a restart after a tool ran keeps its result, continues, and does not run it again', async () => {
	let ran = 0
	let origRun = tools.run
	tools.run = (...args) => (ran++, origRun(...args))
	try {
		let a = client()
		let id = toolSession(a)
		a.conn.send({ type: 'submit', sessionId: id, text: 'look' })
		await until(() => calls.length === 1)
		calls[0]!.push(readCall(), { type: 'done', reason: 'tool_use' })
		await until(() => calls.length === 2)
		expect(ran).toBe(1)
		// The host dies while the model answers the result.
		restartHost()
		await host.recover()
		await until(() => calls.length === 3)
		// The model picks up at the result; no note, nothing was cut off.
		expect(calls[2]!.input.messages).toEqual(calls[1]!.input.messages)
		calls[2]!.push({ type: 'text', text: 'milk' }, { type: 'done', reason: 'end' })
		await until(() => history.readSync(id).at(-1)?.type === 'turn_end')
		let view = await fresh(id)
		expect(view.items.slice(-3)).toEqual([
			{ type: 'tool-result', id: 't1', output: 'remember the milk\n' },
			{ type: 'text', text: 'milk' },
			{ type: 'turn-end', status: 'completed' },
		])
		expect(ran).toBe(1)
	} finally {
		tools.run = origRun
	}
})

test('a tool call cut off by a restart is reported to the model, not run', async () => {
	let ran = 0
	let origRun = tools.run
	tools.run = (...args) => (ran++, origRun(...args))
	try {
		let a = client()
		let id = toolSession(a)
		a.conn.send({ type: 'submit', sessionId: id, text: 'look' })
		await until(() => calls.length === 1)
		calls[0]!.push(readCall())
		await until(() => a.of('stream').length === 1)
		restartHost()
		await host.recover()
		await until(() => calls.length === 2)
		let [result, note] = calls[1]!.input.messages.at(-1).blocks
		expect(result).toMatchObject({ type: 'tool_result', id: 't1', isError: true })
		expect(note).toEqual({ type: 'text', text: replay.continueNote })
		expect(ran).toBe(0)
	} finally {
		tools.run = origRun
	}
})

test('a command cut off mid-run by a crash is never run again, and the model hears it may have run', async () => {
	let ran = 0
	let origRun = tools.run
	tools.run = () => (ran++, new Promise(() => {}))
	try {
		let a = client()
		let id = toolSession(a)
		a.conn.send({ type: 'submit', sessionId: id, text: 'clean up' })
		await until(() => calls.length === 1)
		let rm: StreamEvent = { type: 'tool_call', id: 'b1', name: 'bash', input: { command: 'rm notes.txt', description: 'Delete the notes' } }
		calls[0]!.push(rm, { type: 'done', reason: 'tool_use' })
		await until(() => ran === 1)
		restartHost()
		await host.recover()
		await until(() => calls.length === 2)
		let [result] = calls[1]!.input.messages.at(-1).blocks
		expect(result).toMatchObject({ type: 'tool_result', id: 'b1', isError: true })
		expect(result.output).toMatch(/may or may not have run/)
		expect(ran).toBe(1)
	} finally {
		tools.run = origRun
	}
})

test('a turn that keeps bringing hosts down is paused with a reason, not continued forever', async () => {
	let a = client()
	let id = created(a)
	a.conn.send({ type: 'submit', sessionId: id, text: 'crash' })
	await until(() => calls.length === 1)
	for (let n = 1; n <= states.maxRecoveries(); n++) {
		calls.at(-1)!.push({ type: 'text', text: 'x' })
		await until(() => calls.length === n)
		restartHost()
		await host.recover()
		await until(() => calls.length === n + 1)
	}
	restartHost()
	await host.recover()
	expect(calls.length).toBe(states.maxRecoveries() + 1)
	let view = await fresh(id)
	expect(view.state).toMatchObject({ type: 'paused', reason: expect.stringMatching(/without progress/) })
	expect(view.items.at(-1)).toEqual({ type: 'turn-end', status: 'paused' })
	// The user can still continue it by hand.
	let b = client()
	b.conn.send({ type: 'open', sessionId: id })
	await until(() => b.views.get(id))
	b.conn.send({ type: 'continue', sessionId: id })
	await until(() => calls.length === states.maxRecoveries() + 2)
})

test('pausing a turn another host left unfinished records it paused', async () => {
	let a = client()
	let id = created(a)
	a.conn.send({ type: 'submit', sessionId: id, text: 'go' })
	await until(() => calls.length === 1)
	restartHost()
	let b = client()
	b.conn.send({ type: 'open', sessionId: id })
	await until(() => b.views.get(id))
	b.conn.send({ type: 'pause', sessionId: id })
	await until(() => b.of('turn-end').length)
	expect(b.views.get(id)!.state).toEqual({ type: 'paused' })
	expect(await fresh(id)).toEqual(b.views.get(id)!)
	await host.recover()
	expect(calls.length).toBe(1)
})

test('pause between tool rounds ends the turn and keeps the results', async () => {
	let a = client()
	let id = toolSession(a)
	a.conn.send({ type: 'submit', sessionId: id, text: 'look' })
	await until(() => calls.length === 1)
	calls[0]!.push(readCall(), { type: 'done', reason: 'tool_use' })
	await until(() => calls.length === 2)
	a.conn.send({ type: 'pause', sessionId: id })
	await until(() => a.of('turn-end').length)
	expect(a.of('turn-end')[0].status).toBe('paused')
	let view = await fresh(id)
	expect(view).toEqual(a.views.get(id)!)
	expect(view.items.map((i) => i.type)).toEqual(['prompt', 'tool', 'tool-result', 'turn-end'])
	expect((await records(id)).map((r) => r.type)).toEqual(['user', 'assistant', 'user', 'turn_end'])
})

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
