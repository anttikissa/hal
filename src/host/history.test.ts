import { afterEach, beforeEach, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { lines } from '../common/lines.ts'
import type { DoneEvent, ErrorEvent, Message, StreamEvent } from '../common/blocks.ts'
import type { HistoryRecord } from '../common/replay.ts'
import { diag } from './diag.ts'
import { history } from './history.ts'
import { pages } from './pages.ts'
import { liveFiles } from './live-file.ts'
import { provider } from './provider.ts'
import { sessions } from './sessions.ts'
import { naming } from './naming.ts'

const savedHome = process.env.HAL_HOME
const origOnError = liveFiles.onError
const origStream = provider.stream
const origLog = diag.log
const origPrepare = naming.prepare
let home = ''
let logged: string[] = []

beforeEach(() => {
	home = mkdtempSync(`${tmpdir()}/hal-history-`)
	process.env.HAL_HOME = home
	liveFiles.onError = () => {}
	// History contracts are independent of title reminder scheduling.
	naming.prepare = () => {}
	logged = []
	diag.log = (m) => void logged.push(m)
})

afterEach(() => {
	sessions.closeAll()
	history.state.running.clear()
	provider.stream = origStream
	naming.prepare = origPrepare
	diag.log = origLog
	liveFiles.onError = origOnError
	if (savedHome === undefined) delete process.env.HAL_HOME
	else process.env.HAL_HOME = savedHome
	rmSync(home, { recursive: true, force: true })
})

async function* events(...list: StreamEvent[]): AsyncGenerator<StreamEvent> {
	for (let e of list) yield e
}

async function drain<T>(it: AsyncIterable<T>): Promise<T[]> {
	let out: T[] = []
	for await (let x of it) out.push(x)
	return out
}

// One recorded round ended as a whole turn, however the consumer stops.
async function* ended(id: string, stream: AsyncIterable<StreamEvent>): AsyncGenerator<StreamEvent> {
	let last: DoneEvent | ErrorEvent | undefined
	try {
		for await (let e of history.record(id, 'fake', stream)) {
			if (e.type === 'done' || e.type === 'error') last = e
			yield e
		}
	} finally {
		history.end(id, last)
	}
}

const strip = (records: HistoryRecord[]) => records.map(({ ts: _ts, n: _n, ...rest }) => rest)
const newSession = () => sessions.create({ cwd: '/', model: 'fake/m', name: 'History fixture' }).id

// Lets a test see what a turn sent and script what comes back.
function fakeStream(script: (input: { messages: Message[] }) => StreamEvent[]) {
	let sent: Message[][] = []
	provider.stream = async function* (_model, input) {
		sent.push(structuredClone(input.messages))
		yield* script(input)
	}
	return sent
}

test('a completed turn is stored as prompt, blocks and a turn end with usage', async () => {
	let id = newSession()
	history.submit(id, 'hello')
	let seen = await drain(
		ended(
			id,
			events(
				{ type: 'thinking', text: 'hm' },
				{ type: 'signature', value: 'sig' },
				{ type: 'text', text: 'hi ' },
				{ type: 'text', text: 'there' },
				{ type: 'usage', usage: { input: 10 } },
				{ type: 'usage', usage: { output: 3 } },
				{ type: 'done', reason: 'end' },
			),
		),
	)
	expect(seen).toHaveLength(7)
	let records = await history.read(id)
	expect(strip(records)).toEqual([
		{ type: 'user', blocks: [{ type: 'text', text: 'hello' }] },
		{ type: 'assistant', block: { type: 'thinking', text: 'hm', signatureBlob: expect.any(String), provider: 'fake' } },
		{ type: 'assistant', block: { type: 'text', text: 'hi there' } },
		{ type: 'round', usage: { input: 10, output: 3 }, block: 2 },
		{ type: 'turn_end', status: 'completed', reason: 'end', usage: { input: 10, output: 3 }, context: 10 },
	])
	for (let r of records) expect(Date.parse(r.ts)).not.toBeNaN()
})

test('each block reaches disk once complete, before the turn ends', async () => {
	let id = newSession()
	history.submit(id, 'go')
	let it = ended(id, events({ type: 'text', text: 'a' }, { type: 'tool_call', id: 't', name: 'x', input: {} }, { type: 'done', reason: 'tool_use' }))
	await it.next()
	expect(strip(await history.read(id)).map((r) => r.type)).toEqual(['user'])
	await it.next() // the tool call has been yielded: the text before it is complete
	expect(strip(await history.read(id)).map((r) => r.type)).toEqual(['user', 'assistant'])
	await drain(it)
	expect(strip(await history.read(id)).at(-1)).toMatchObject({ type: 'turn_end', reason: 'tool_use' })
})

test('cancellation keeps the partial reply and records the turn as paused', async () => {
	let id = newSession()
	let sent = fakeStream((input) =>
		input.messages.length === 1
			? [{ type: 'text', text: 'partial' }, { type: 'usage', usage: { input: 5 } }, { type: 'error', message: 'Cancelled', cancelled: true }]
			: [{ type: 'done', reason: 'end' }],
	)
	history.submit(id, 'first')
	await drain(history.turn(id))
	let last = (await history.read(id)).at(-1)
	expect(last).toMatchObject({ type: 'turn_end', status: 'paused', usage: { input: 5 } })
	history.submit(id, 'second')
	await drain(history.turn(id))
	// The model is told the turn was paused, in front of the new prompt.
	expect(sent[1]).toEqual([
		{ role: 'user', blocks: [{ type: 'text', text: expect.stringMatching(/^\[[\d -]+:\d\d\]\nfirst$/) }] },
		{ role: 'assistant', blocks: [{ type: 'text', text: 'partial' }] },
		{ role: 'user', blocks: [{ type: 'text', text: expect.stringMatching(/^\[[\d -]+:\d\d\]\n<meta>[^<]*paused[^<]*<\/meta>\nsecond$/) }] },
	])
})

test('a consumer that stops early still ends the turn, as paused', async () => {
	let id = newSession()
	history.submit(id, 'x')
	for await (let _ of ended(id, events({ type: 'text', text: 'a' }, { type: 'text', text: 'b' }, { type: 'done', reason: 'end' }))) break
	expect(strip(await history.read(id)).slice(1)).toEqual([
		{ type: 'assistant', block: { type: 'text', text: 'a' } },
		{ type: 'turn_end', status: 'paused', usage: {} },
	])
	expect(history.state.running.has(id)).toBe(false)
})

test('a prompt after a failed turn is its own message, told of the failure', async () => {
	let id = newSession()
	let sent = fakeStream((input) => (input.messages.length === 1 ? [{ type: 'error', message: 'HTTP 400 from fake', status: 400 }] : [{ type: 'done', reason: 'end' }]))
	history.submit(id, 'Say just the word pong')
	await drain(history.turn(id))
	history.submit(id, 'k')
	await drain(history.turn(id))
	expect(sent[1]).toEqual([
		{ role: 'user', blocks: [{ type: 'text', text: expect.stringMatching(/^\[[\d -]+:\d\d\]\nSay just the word pong$/) }] },
		{ role: 'user', blocks: [{ type: 'text', text: expect.stringMatching(/^\[[\d -]+:\d\d\]\n<meta>[^<]*failed[^<]*HTTP 400 from fake<\/meta>\nk$/) }] },
	])
})

test('thinking signatures live in blobs and replay exactly, rebuilt from disk alone', async () => {
	let id = newSession()
	let signature = `{"type":"reasoning","id":"rs_1","encrypted_content":"gAAA\\u0000'\`\${x}"}\n\t\\ ä😀 ${'z'.repeat(5000)}`
	let sent = fakeStream((input) =>
		input.messages.length === 1
			? [{ type: 'thinking', text: 'why' }, { type: 'signature', value: signature }, { type: 'text', text: 'ok' }, { type: 'done', reason: 'end' }]
			: [{ type: 'done', reason: 'end' }],
	)
	history.submit(id, 'q1')
	await drain(history.turn(id))
	// Every record is one line, and the signature is not among them.
	let lines = readFileSync(history.file(id), 'utf8').trimEnd().split('\n')
	expect(lines).toHaveLength(4)
	expect(lines.join('\n')).not.toContain('zzzz')
	sessions.closeAll()
	await history.open(id)
	history.submit(id, 'q2')
	await drain(history.turn(id))
	expect(sent[1]![1]).toEqual({
		role: 'assistant',
		blocks: [
			{ type: 'thinking', text: 'why', signature, provider: 'fake' },
			{ type: 'text', text: 'ok' },
		],
	})
})

test('open recovers a partially written last record and appends cleanly after it', async () => {
	let id = newSession()
	history.submit(id, 'kept')
	appendFileSync(history.file(id), "{ type: 'assistant', block: { type: 'text', text: 'secret-ish")
	sessions.closeAll()
	// Reading alone neither fails nor repairs.
	expect(strip(await history.read(id))).toEqual([{ type: 'user', blocks: [{ type: 'text', text: 'kept' }] }])
	expect(readFileSync(history.file(id), 'utf8')).toContain('secret-ish')
	await history.open(id)
	expect(logged.join('\n')).toMatch(/partial/)
	expect(logged.join('\n')).not.toContain('secret-ish')
	history.submit(id, 'after')
	let records = strip(await history.read(id))
	expect(records).toEqual([
		{ type: 'user', blocks: [{ type: 'text', text: 'kept' }] },
		{ type: 'user', blocks: [{ type: 'text', text: 'after' }] },
	])
})

test('a complete last record missing its newline is kept', async () => {
	let id = newSession()
	let line = lines.encode({ type: 'user', blocks: [{ type: 'text', text: 'a' }], ts: new Date().toISOString() })
	writeFileSync(history.file(id), line + line.trimEnd())
	sessions.closeAll()
	await history.open(id)
	history.submit(id, 'b')
	expect(strip(await history.read(id)).map((r) => r.type)).toEqual(['user', 'user', 'user'])
})

test('a corrupt record mid-file is reported when read and the file left untouched', async () => {
	let id = newSession()
	history.submit(id, 'a')
	appendFileSync(history.file(id), '{ type: @@ }\n' + lines.encode({ type: 'user', blocks: [{ type: 'text', text: 'b' }], ts: new Date().toISOString() }))
	sessions.closeAll()
	let before = readFileSync(history.file(id), 'utf8')
	// Opening reads only the end of the history.
	await history.open(id)
	expect(() => history.readSync(id)).toThrow(new RegExp(id))
	await expect(history.read(id)).rejects.toThrow()
	expect(readFileSync(history.file(id), 'utf8')).toBe(before)
})

test('open leaves an unfinished turn unfinished, for the host to continue', async () => {
	let id = newSession()
	history.submit(id, 'q')
	history.append(id, { type: 'assistant', block: { type: 'tool_call', id: 't1', name: 'bash', input: {} } })
	sessions.closeAll()
	let before = readFileSync(history.file(id), 'utf8')
	await history.open(id)
	expect(readFileSync(history.file(id), 'utf8')).toBe(before)
})

test('a host exiting mid-turn writes the output so far and leaves the turn unfinished', async () => {
	let id = newSession()
	history.submit(id, 'q')
	let it = ended(id, events({ type: 'text', text: 'a' }, { type: 'usage', usage: { output: 1 } }, { type: 'text', text: 'b' }, { type: 'done', reason: 'end' }))
	await it.next()
	await it.next()
	history.stop(false)
	expect(history.live(id)).toBeUndefined()
	// Whatever the abandoned stream does afterwards writes nothing more.
	await drain(it)
	expect(strip(await history.read(id)).slice(1)).toEqual([{ type: 'assistant', block: { type: 'text', text: 'a' } }])
})

test('the last Hal process quitting mid-turn records it paused, once', async () => {
	let id = newSession()
	history.submit(id, 'q')
	let it = ended(id, events({ type: 'text', text: 'a' }, { type: 'usage', usage: { output: 1 } }, { type: 'text', text: 'b' }, { type: 'done', reason: 'end' }))
	await it.next()
	await it.next()
	history.stop(true)
	history.stop(true)
	await drain(it)
	expect(strip(await history.read(id)).slice(1)).toEqual([
		{ type: 'assistant', block: { type: 'text', text: 'a' } },
		{ type: 'turn_end', status: 'paused', usage: { output: 1 } },
	])
})

test('a stream that throws ends the turn as an error, yielded and recorded', async () => {
	let id = newSession()
	history.submit(id, 'x')
	async function* broken(): AsyncGenerator<StreamEvent> {
		yield { type: 'text', text: 'half' }
		throw new Error('socket hang up')
	}
	let seen = await drain(ended(id, broken()))
	expect(seen.at(-1)).toEqual({ type: 'error', message: 'socket hang up' })
	expect(strip(await history.read(id)).slice(1)).toEqual([
		{ type: 'assistant', block: { type: 'text', text: 'half' } },
		{ type: 'turn_end', status: 'error', error: 'socket hang up', usage: {} },
	])
	expect(history.state.running.has(id)).toBe(false)
})

test('live output and the file together always hold the whole turn once', async () => {
	let id = newSession()
	history.submit(id, 'go')
	let it = ended(id, events({ type: 'text', text: 'a' }, { type: 'text', text: 'b' }, { type: 'tool_call', id: 't', name: 'x', input: {} }, { type: 'usage', usage: { output: 2 } }, { type: 'done', reason: 'tool_use' }))
	let whole = () => [...history.readSync(id).flatMap((r) => (r.type === 'assistant' ? [r.block] : [])), ...(history.live(id)?.blocks ?? [])]
	await it.next()
	expect(whole()).toEqual([{ type: 'text', text: 'a' }])
	await it.next()
	expect(whole()).toEqual([{ type: 'text', text: 'ab' }])
	await it.next()
	expect(whole()).toEqual([{ type: 'text', text: 'ab' }, { type: 'tool_call', id: 't', name: 'x', input: {} }])
	await it.next()
	expect(history.live(id)!.usage).toEqual({ output: 2 })
	await drain(it)
	expect(history.live(id)).toBeUndefined()
	expect(whole()).toEqual([{ type: 'text', text: 'ab' }, { type: 'tool_call', id: 't', name: 'x', input: {} }])
})

test('readSync agrees with read, skipping a partial last record', async () => {
	let id = newSession()
	expect(history.readSync(id)).toEqual([])
	expect(await history.read(id)).toEqual([])
	expect(await history.messages(id)).toEqual([])
	expect((await history.open(id)).id).toBe(id)
	history.submit(id, 'a')
	await drain(ended(id, events({ type: 'text', text: 'b' }, { type: 'done', reason: 'end' })))
	appendFileSync(history.file(id), "{ type: 'user', blo")
	expect(history.readSync(id)).toEqual(await history.read(id))
	expect(history.readSync(id)).toHaveLength(3)
	appendFileSync(history.file(id), "\n{ type: @@ }\n")
	expect(() => history.readSync(id)).toThrow(new RegExp(id))
})

test('a turn spans tool rounds: one turn end with the usage of all rounds', async () => {
	let id = newSession()
	history.submit(id, 'q')
	let call = { type: 'tool_call' as const, id: 't1', name: 'read', input: {} }
	await drain(history.record(id, 'fake', events(call, { type: 'usage', usage: { input: 10, output: 1 } }, { type: 'done', reason: 'tool_use' })))
	// Between rounds the turn is still running: open leaves it alone.
	await history.open(id)
	history.results(id, [{ type: 'tool_result', id: 't1', output: 'x' }])
	await drain(history.record(id, 'fake', events({ type: 'usage', usage: { input: 12, output: 2 } }, { type: 'done', reason: 'end' })))
	history.end(id, { type: 'done', reason: 'end' })
	history.end(id, { type: 'done', reason: 'end' })
	expect(strip(await history.read(id)).slice(1)).toEqual([
		{ type: 'assistant', block: call },
		{ type: 'round', usage: { input: 10, output: 1 }, block: 2 },
		{ type: 'user', blocks: [{ type: 'tool_result', id: 't1', output: 'x' }] },
		{ type: 'round', usage: { input: 12, output: 2 } },
		// The context is the last round's input alone, not the sum.
		{ type: 'turn_end', status: 'completed', reason: 'end', usage: { input: 22, output: 3 }, context: 12 },
	])
})

test('a host quitting between tool rounds pauses the turn once; late results are dropped', async () => {
	let id = newSession()
	history.submit(id, 'q')
	await drain(history.record(id, 'fake', events({ type: 'tool_call', id: 't1', name: 'read', input: {} }, { type: 'usage', usage: { output: 4 } }, { type: 'done', reason: 'tool_use' })))
	history.stop(true)
	history.results(id, [{ type: 'tool_result', id: 't1', output: 'late' }])
	history.end(id, undefined)
	expect(strip(await history.read(id)).map((r) => r.type)).toEqual(['user', 'assistant', 'round', 'turn_end'])
	expect((await history.read(id)).at(-1)).toMatchObject({ status: 'paused', usage: { output: 4 } })
})

test('unfinished: a turn with no end record, however long its last line', async () => {
	let id = newSession()
	expect(history.unfinished(id)).toBe(false)
	history.submit(id, 'q')
	expect(history.unfinished(id)).toBe(true)
	history.append(id, { type: 'turn_end', status: 'completed', usage: {} })
	expect(history.unfinished(id)).toBe(false)
	history.submit(id, 'x'.repeat(200_000))
	expect(history.unfinished(id)).toBe(true)
	history.append(id, { type: 'turn_end', status: 'paused', pauseReason: 'y'.repeat(100_000), usage: {} })
	expect(history.unfinished(id)).toBe(false)
	// A record cut off mid-write never happened; open drops it.
	appendFileSync(history.file(id), "{ type: 'user', blocks: [")
	expect(history.unfinished(id)).toBe(false)
})

// A fresh process: nothing of the session's numbers in memory.
function forget() {
	history.state.next.clear()
	history.state.cache.clear()
	pages.reset()
}

test('every record is numbered once; a streamed block keeps the number it started with', async () => {
	let id = newSession()
	history.submit(id, 'go')
	let gate = Promise.withResolvers<void>()
	let it = history.record(id, 'fake', (async function* (): AsyncGenerator<StreamEvent> {
		yield { type: 'text', text: 'wor' }
		await gate.promise
		yield { type: 'text', text: 'king' }
		yield { type: 'done', reason: 'end' }
	})())
	await it.next()
	let streaming = history.streaming(id)
	expect(history.live(id)?.ns).toEqual([streaming!])
	// Written while the block streams: numbered past it.
	let beside = history.append(id, { type: 'output', text: 'meanwhile' })
	gate.resolve()
	await drain(it)
	history.end(id, { type: 'done', reason: 'end' })
	let records = history.readSync(id)
	let block = records.find((r) => r.type === 'assistant')!
	expect(block.n).toBe(streaming!)
	expect(beside.n).toBeGreaterThan(streaming!)
	let ns = records.map((r) => r.n!)
	expect(new Set(ns).size).toBe(records.length)
	// A later host numbers past all of them, even the block written last.
	forget()
	expect(history.submit(id, 'next').n).toBeGreaterThan(Math.max(...ns))
})

test('records of an old history without numbers are numbered by place, and new ones past them', async () => {
	let id = newSession()
	let line = (text: string) => lines.encode({ type: 'user', blocks: [{ type: 'text', text }], ts: new Date().toISOString() })
	writeFileSync(history.file(id), line('a') + line('b'))
	forget()
	let old = history.readSync(id).map((r) => r.n)
	expect(old).toEqual([1, Buffer.byteLength(line('a')) + 1])
	// Paged reads number them alike.
	expect(pages.page(id).records.map((r) => r.n)).toEqual(old)
	let added = history.submit(id, 'c').n!
	expect(added).toBeGreaterThan(old[1]!)
	forget()
	expect(history.readSync(id).map((r) => r.n)).toEqual([...old, added])
	expect(history.submit(id, 'd').n).toBe(added + 1)
})

test('a number that is not an integer is corrupt history', async () => {
	let id = newSession()
	writeFileSync(history.file(id), lines.encode({ type: 'continue', n: 'x', ts: new Date().toISOString() }))
	forget()
	expect(() => history.readSync(id)).toThrow(new RegExp(id))
})

test('a failed turn stores the provider body with the message, never just a headline', async () => {
	let id = newSession()
	fakeStream(() => [{ type: 'error', message: 'Invalid JSON input', body: '{"command": "ls' }])
	history.submit(id, 'go')
	await drain(history.turn(id))
	expect((await history.read(id)).at(-1)).toMatchObject({ type: 'turn_end', status: 'error', error: 'Invalid JSON input\n{"command": "ls' })
})
