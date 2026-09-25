import { afterEach, beforeEach, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { ason } from '../common/ason.ts'
import type { Message, StreamEvent } from '../common/blocks.ts'
import type { HistoryRecord } from '../common/replay.ts'
import { diag } from './diag.ts'
import { history } from './history.ts'
import { liveFiles } from './live-file.ts'
import { provider } from './provider.ts'
import { sessions } from './sessions.ts'

const savedHome = process.env.HAL_HOME
const origOnError = liveFiles.onError
const origStream = provider.stream
const origLog = diag.log
let home = ''
let logged: string[] = []

beforeEach(() => {
	home = mkdtempSync(`${tmpdir()}/hal-history-`)
	process.env.HAL_HOME = home
	liveFiles.onError = () => {}
	logged = []
	diag.log = (m) => void logged.push(m)
})

afterEach(() => {
	sessions.closeAll()
	history.state.running.clear()
	provider.stream = origStream
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

const strip = (records: HistoryRecord[]) => records.map(({ ts: _ts, ...rest }) => rest)
const newSession = () => sessions.create({ cwd: '/', model: 'fake/m' }).id

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
		history.record(
			id,
			'fake',
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
		{ type: 'assistant', block: { type: 'thinking', text: 'hm', signature: 'sig', provider: 'fake' } },
		{ type: 'assistant', block: { type: 'text', text: 'hi there' } },
		{ type: 'turn_end', status: 'completed', reason: 'end', usage: { input: 10, output: 3 } },
	])
	for (let r of records) expect(Date.parse(r.ts)).not.toBeNaN()
})

test('each block reaches disk once complete, before the turn ends', async () => {
	let id = newSession()
	history.submit(id, 'go')
	let it = history.record(id, 'fake', events({ type: 'text', text: 'a' }, { type: 'tool_call', id: 't', name: 'x', input: {} }, { type: 'done', reason: 'tool_use' }))
	await it.next()
	expect(strip(await history.read(id)).map((r) => r.type)).toEqual(['user'])
	await it.next() // the tool call has been yielded: the text before it is complete
	expect(strip(await history.read(id)).map((r) => r.type)).toEqual(['user', 'assistant'])
	await drain(it)
	expect(strip(await history.read(id)).at(-1)).toMatchObject({ type: 'turn_end', reason: 'tool_use' })
})

test('cancellation keeps the partial reply and records the turn as cancelled', async () => {
	let id = newSession()
	let sent = fakeStream((input) =>
		input.messages.length === 1
			? [{ type: 'text', text: 'partial' }, { type: 'usage', usage: { input: 5 } }, { type: 'error', message: 'Cancelled', cancelled: true }]
			: [{ type: 'done', reason: 'end' }],
	)
	history.submit(id, 'first')
	await drain(history.turn(id))
	let last = (await history.read(id)).at(-1)
	expect(last).toMatchObject({ type: 'turn_end', status: 'cancelled', usage: { input: 5 } })
	history.submit(id, 'second')
	await drain(history.turn(id))
	expect(sent[1]).toEqual([
		{ role: 'user', blocks: [{ type: 'text', text: 'first' }] },
		{ role: 'assistant', blocks: [{ type: 'text', text: 'partial' }] },
		{ role: 'user', blocks: [{ type: 'text', text: 'second' }] },
	])
})

test('a consumer that stops early still ends the turn, as cancelled', async () => {
	let id = newSession()
	history.submit(id, 'x')
	for await (let _ of history.record(id, 'fake', events({ type: 'text', text: 'a' }, { type: 'text', text: 'b' }, { type: 'done', reason: 'end' }))) break
	expect(strip(await history.read(id)).slice(1)).toEqual([
		{ type: 'assistant', block: { type: 'text', text: 'a' } },
		{ type: 'turn_end', status: 'cancelled', usage: {} },
	])
	expect(history.state.running.has(id)).toBe(false)
})

test('a failed turn records the error', async () => {
	let id = newSession()
	history.submit(id, 'x')
	await drain(history.record(id, 'fake', events({ type: 'error', message: 'HTTP 500 from fake', status: 500 })))
	expect((await history.read(id)).at(-1)).toMatchObject({ type: 'turn_end', status: 'error', error: 'HTTP 500 from fake' })
})

test('thinking signatures replay exactly, rebuilt from disk alone', async () => {
	let id = newSession()
	let signature = `{"type":"reasoning","id":"rs_1","encrypted_content":"gAAA\\u0000'\`\${x}"}\n\t\\ ä😀 ${'z'.repeat(5000)}`
	let sent = fakeStream((input) =>
		input.messages.length === 1
			? [{ type: 'thinking', text: 'why' }, { type: 'signature', value: signature }, { type: 'text', text: 'ok' }, { type: 'done', reason: 'end' }]
			: [{ type: 'done', reason: 'end' }],
	)
	history.submit(id, 'q1')
	await drain(history.turn(id))
	// Every record is one line.
	expect(readFileSync(history.file(id), 'utf8').trimEnd().split('\n')).toHaveLength(4)
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

test('a turn uses the session model and passes options through', async () => {
	let id = sessions.create({ cwd: '/', model: 'fake/big' }).id
	let got: unknown[] = []
	provider.stream = async function* (model, input, signal) {
		got.push(model, input.system, signal)
		yield { type: 'done', reason: 'end' }
	}
	let ac = new AbortController()
	history.submit(id, 'x')
	await drain(history.turn(id, { system: 'be brief' }, ac.signal))
	expect(got).toEqual(['fake/big', 'be brief', ac.signal])
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
	expect(records.map((r) => r.type)).toEqual(['user', 'turn_end', 'user'])
	expect(records[1]).toMatchObject({ status: 'interrupted' })
	expect(records[2]).toEqual({ type: 'user', blocks: [{ type: 'text', text: 'after' }] })
})

test('a complete last record missing its newline is kept', async () => {
	let id = newSession()
	let line = ason.stringifyLine({ type: 'user', blocks: [{ type: 'text', text: 'a' }], ts: new Date().toISOString() })
	writeFileSync(history.file(id), line + line.trimEnd())
	sessions.closeAll()
	await history.open(id)
	history.submit(id, 'b')
	expect(strip(await history.read(id)).map((r) => r.type)).toEqual(['user', 'user', 'turn_end', 'user'])
})

test('a corrupt record mid-file is reported and the file left untouched', async () => {
	let id = newSession()
	history.submit(id, 'a')
	appendFileSync(history.file(id), '{ type: @@ }\n')
	history.submit(id, 'b')
	sessions.closeAll()
	let before = readFileSync(history.file(id), 'utf8')
	await expect(history.open(id)).rejects.toThrow(new RegExp(id))
	await expect(history.read(id)).rejects.toThrow()
	expect(readFileSync(history.file(id), 'utf8')).toBe(before)
	expect(sessions.openIds()).toEqual([])
})

test('a turn left open by a dead host is closed as interrupted on open, once', async () => {
	let id = newSession()
	history.submit(id, 'q')
	history.append(id, { type: 'assistant', block: { type: 'tool_call', id: 't1', name: 'bash', input: {} } })
	sessions.closeAll()
	await history.open(id)
	await history.open(id)
	sessions.closeAll()
	await history.open(id)
	let records = strip(await history.read(id))
	expect(records.filter((r) => r.type === 'turn_end')).toEqual([{ type: 'turn_end', status: 'interrupted', usage: {} }])
	// The next prompt replays with the dangling tool call answered.
	history.submit(id, 'again')
	let msgs = await history.messages(id)
	expect(msgs.at(-1)!.blocks[0]).toMatchObject({ type: 'tool_result', id: 't1', isError: true })
})

test('open does not close a turn that is running in this host', async () => {
	let id = newSession()
	history.submit(id, 'q')
	let it = history.record(id, 'fake', events({ type: 'text', text: 'a' }, { type: 'done', reason: 'end' }))
	await it.next()
	await history.open(id)
	await drain(it)
	let ends = (await history.read(id)).filter((r) => r.type === 'turn_end')
	expect(ends).toMatchObject([{ status: 'completed' }])
})

test('a session without history has no records and no messages', async () => {
	let id = newSession()
	expect(await history.read(id)).toEqual([])
	expect(await history.messages(id)).toEqual([])
	expect((await history.open(id)).id).toBe(id)
})
