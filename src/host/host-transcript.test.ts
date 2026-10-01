// Transcript projection against the real host: a client that followed
// a turn's events and one that connected afterwards show the same thing.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import type { StreamEvent } from '../common/blocks.ts'
import type { Event } from '../common/protocol.ts'
import { transcript, type Transcript } from '../common/transcript.ts'
import { shown } from './host-fixture.test.ts'
import { host } from './host.ts'
import { turns } from './turns.ts'
import { liveFiles } from './live-file.ts'
import { sessions } from './sessions.ts'
import { naming } from './naming.ts'

const savedHome = process.env.HAL_HOME
const origStream = turns.stream
const origOnError = liveFiles.onError
let home = ''

// Each provider call yields what the test pushes; an abort ends it as
// cancelled, like provider.stream.
let pushes: ((...e: StreamEvent[]) => void)[] = []

function scripted(_model: string, _input: unknown, signal?: AbortSignal): AsyncIterable<StreamEvent> {
	let queue: StreamEvent[] = []
	let wake = () => {}
	pushes.push((...e) => {
		queue.push(...e)
		wake()
	})
	signal?.addEventListener('abort', () => wake())
	return (async function* () {
		while (true) {
			if (signal?.aborted) return yield { type: 'error', message: 'Cancelled', cancelled: true }
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
	home = mkdtempSync(`${tmpdir()}/hal-transcript-`)
	process.env.HAL_HOME = home
	liveFiles.onError = () => {}
	turns.stream = scripted
	pushes = []
})

afterEach(() => {
	host.reset()
	sessions.closeAll()
	turns.stream = origStream
	liveFiles.onError = origOnError
	if (savedHome === undefined) delete process.env.HAL_HOME
	else process.env.HAL_HOME = savedHome
	rmSync(home, { recursive: true, force: true })
})

function viewer() {
	let v: { t?: Transcript; ends: number; send: (c: unknown) => void } = { ends: 0, send: () => {} }
	let conn = host.connect((e: Event) => {
		v.t = transcript.fold(v.t, e)
		if (e.type === 'turn-end') v.ends++
	})
	v.send = conn.send
	return v
}

async function until(check: () => unknown): Promise<void> {
	for (let i = 0; i < 200; i++) {
		if (check()) return
		await new Promise((r) => setTimeout(r, 1))
	}
	throw new Error('timed out')
}

// Runs one turn watched from the start, and by a client that joins
// mid-turn; `finish` ends it. Returns both and one that joins after.
async function turn(finish: (push: (...e: StreamEvent[]) => void, send: (c: unknown) => void, id: string) => void | Promise<void>) {
	let early = viewer()
	early.send({ type: 'create', cwd: '/tmp/w', model: 'fake/m' })
	let id = early.t!.meta.id
	naming.manual(id, sessions.open(id).name)
	early.send({ type: 'submit', sessionId: id, text: 'go' })
	await until(() => pushes.length === 1)
	pushes[0]!({ type: 'thinking', text: 'hm' }, { type: 'signature', value: 's' }, { type: 'text', text: 'par' })
	await until(() => early.t!.items.some((i) => i.type === 'text'))
	let mid = viewer()
	mid.send({ type: 'open', sessionId: id })
	await finish(pushes[0]!, early.send, id)
	await until(() => early.ends && mid.ends)
	let late = viewer()
	late.send({ type: 'open', sessionId: id })
	return { early: early.t!, mid: mid.t!, late: late.t! }
}

test('completed: every client shows the same finished turn', async () => {
	let { early, mid, late } = await turn(async (push) => {
		push({ type: 'text', text: 'tial' }, { type: 'tool_call', id: 't', name: 'ls', input: {} }, { type: 'usage', usage: { output: 3 } }, { type: 'done', reason: 'tool_use' })
		await until(() => pushes.length === 2)
		pushes[1]!({ type: 'text', text: 'done' }, { type: 'usage', usage: { output: 1 } }, { type: 'done', reason: 'end' })
	})
	expect(shown(late.items)).toEqual([
		{ type: 'output', text: expect.any(String) },
		{ type: 'prompt', text: 'go' },
		{ type: 'thinking', text: 'hm' },
		{ type: 'text', text: 'partial' },
		{ type: 'tool', id: 't', name: 'ls', input: {} },
		{ type: 'tool-result', id: 't', output: "Error: unknown tool 'ls'", isError: true },
		{ type: 'text', text: 'done' },
		{ type: 'turn-end', status: 'completed', usage: { output: 4 } },
	])
	expect(early).toEqual(late)
	expect(mid).toEqual(late)
})

test('paused: partial output and the pause look the same everywhere', async () => {
	let { early, mid, late } = await turn((_push, send, id) => send({ type: 'pause', sessionId: id }))
	expect(shown(late.items.slice(-2))).toEqual([
		{ type: 'text', text: 'par' },
		{ type: 'turn-end', status: 'paused' },
	])
	expect(late.state).toEqual({ type: 'paused' })
	expect(early).toEqual(late)
	expect(mid).toEqual(late)
})

test('a command mid-round shows where history has it, live and after a reload', async () => {
	let early = viewer()
	early.send({ type: 'create', cwd: '/tmp/w', model: 'fake/m' })
	let id = early.t!.meta.id
	early.send({ type: 'submit', sessionId: id, text: 'go' })
	await until(() => pushes.length === 1)
	let push = pushes[0]!
	// The thinking is finished (in history); the text still streams.
	push({ type: 'thinking', text: 'hm' }, { type: 'signature', value: 's' }, { type: 'text', text: 'par' })
	await until(() => early.t!.items.some((i) => i.type === 'text'))
	early.send({ type: 'submit', sessionId: id, text: '/help' })
	await until(() => early.t!.items.filter((i) => i.type === 'output').length === 2)
	let mid = viewer()
	mid.send({ type: 'open', sessionId: id })
	// More text goes into the block above the command.
	push({ type: 'text', text: 'tial' }, { type: 'tool_call', id: 't', name: 'ls', input: {} })
	await until(() => early.t!.items.some((i) => i.type === 'tool'))
	early.send({ type: 'submit', sessionId: id, text: '/help' })
	await until(() => early.t!.items.filter((i) => i.type === 'output').length === 3)
	push({ type: 'done', reason: 'tool_use' })
	await until(() => pushes.length === 2)
	pushes[1]!({ type: 'text', text: 'done' }, { type: 'done', reason: 'end' })
	await until(() => early.ends && mid.ends)
	let late = viewer()
	late.send({ type: 'open', sessionId: id })
	let order = (t: Transcript) => t.items.map((i) => (i.type === 'text' ? i.text : i.type))
	expect(order(late.t!)).toEqual(['output', 'prompt', 'thinking', 'command', 'output', 'partial', 'command', 'output', 'tool', 'tool-result', 'done', 'turn-end'])
	expect(early.t).toEqual(late.t)
	expect(mid.t).toEqual(late.t)
})
