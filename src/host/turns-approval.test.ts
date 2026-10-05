import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import type { StreamEvent } from '../common/blocks.ts'
import type { Event } from '../common/protocol.ts'
import { settings } from '../common/settings.ts'
import { transcript, type Transcript } from '../common/transcript.ts'
import { history } from './history.ts'
import { host } from './host.ts'
import { turns } from './turns.ts'
import { liveFiles } from './live-file.ts'
import { sessions } from './sessions.ts'
import { tools } from './tools.ts'

const savedHome = process.env.HAL_HOME
const origStream = turns.stream
const origOnError = liveFiles.onError
const origRun = tools.run
let home = ''
let ran: string[] = []

// A scripted provider: each call waits for events pushed by the test.
type Call = { input: any; push: (...e: StreamEvent[]) => void }
let calls: Call[] = []

function fakeStream(_model: string, input: any, signal?: AbortSignal): AsyncIterable<StreamEvent> {
	let queue: StreamEvent[] = []
	let wake = () => {}
	calls.push({ input, push: (...e) => (queue.push(...e), wake()) })
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
	home = mkdtempSync(`${tmpdir()}/hal-approval-`)
	process.env.HAL_HOME = home
	liveFiles.onError = () => {}
	turns.stream = fakeStream
	calls = []
	ran = []
	tools.run = (call, ctx) => (ran.push(call.id), origRun(call, ctx))
	writeFileSync(`${home}/notes.txt`, 'milk\n')
	mkdirSync(`${home}/junk`)
})

afterEach(() => {
	host.reset()
	sessions.closeAll()
	history.state.running.clear()
	turns.stream = origStream
	tools.run = origRun
	settings.state.raw = {}
	liveFiles.onError = origOnError
	if (savedHome === undefined) delete process.env.HAL_HOME
	else process.env.HAL_HOME = savedHome
	rmSync(home, { recursive: true, force: true })
})

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
	for (let i = 0; i < 300; i++) {
		if (check()) return
		await new Promise((r) => setTimeout(r, 1))
	}
	throw new Error('timed out')
}

function session(c: ReturnType<typeof client>): string {
	c.conn.send({ type: 'create', cwd: home, model: 'fake/m1' })
	return c.of('snapshot').at(-1).sessionId
}

async function opened(id: string) {
	let c = client()
	c.conn.send({ type: 'open', sessionId: id })
	await until(() => c.views.get(id))
	return c
}

const bash = (id: string, command: string): StreamEvent => ({ type: 'tool_call', id, name: 'bash', input: { command, description: 'Clean up' } })
const read = (id: string): StreamEvent => ({ type: 'tool_call', id, name: 'read', input: { path: 'notes.txt' } })
const round1 = (...events: StreamEvent[]) => calls[0]!.push(...events, { type: 'usage', usage: { input: 10, output: 5 } }, { type: 'done', reason: 'tool_use' })
const finish = (call: Call) => call.push({ type: 'text', text: 'done' }, { type: 'usage', usage: { input: 20, output: 1 } }, { type: 'done', reason: 'end' })
const results = (call: Call) => call.input.messages.flatMap((m: any) => m.blocks).filter((b: any) => b.type === 'tool_result')

test('each dangerous call is asked once, harmless ones not at all; answers survive a restart and results keep call order', async () => {
	let a = client()
	let id = session(a)
	a.conn.send({ type: 'submit', sessionId: id, text: 'tidy' })
	await until(() => calls.length === 1)
	round1(bash('b1', 'rm -rf junk'), read('r1'), bash('b2', 'git reset --hard'))
	await until(() => transcript.question(a.views.get(id)))
	let first = transcript.question(a.views.get(id))!
	expect(first.form.quote!.text).toBe('rm -rf junk')
	a.conn.send({ type: 'answer', sessionId: id, question: first.id, answers: { run: 'yes' } })
	await until(() => transcript.question(a.views.get(id))?.id !== first.id && transcript.question(a.views.get(id)))
	let second = transcript.question(a.views.get(id))!
	expect(second.form.quote!.text).toBe('git reset --hard')
	expect(ran).toEqual([])

	// The host goes away while the second question waits.
	host.reset()
	sessions.closeAll()
	history.state.running.clear()
	await turns.recover()
	let b = await opened(id)
	expect(transcript.question(b.views.get(id))?.id).toBe(second.id)
	b.conn.send({ type: 'answer', sessionId: id, question: second.id, answers: { run: 'no' } })
	await until(() => calls.length === 2)
	expect(ran).toEqual(['b1', 'r1'])
	expect(existsSync(`${home}/junk`)).toBe(false)
	expect(results(calls[1]!).map((r: any) => [r.id, !!r.isError])).toEqual([
		['b1', false],
		['r1', false],
		['b2', true],
	])
	expect(calls[1]!.input.messages.filter((m: any) => m.role === 'assistant')).toHaveLength(1)
	finish(calls[1]!)
	await until(() => b.of('turn-end').length)
	expect(b.of('turn-end')[0].usage).toEqual({ input: 30, output: 6 })
	expect(history.readSync(id).filter((r) => r.type === 'question')).toHaveLength(2)
})

test("Escape at an approval pauses with the turn's usage; the call has not run and continue asks again", async () => {
	let a = client()
	let id = session(a)
	a.conn.send({ type: 'submit', sessionId: id, text: 'clean' })
	await until(() => calls.length === 1)
	round1(bash('b1', 'rm -rf junk'))
	await until(() => transcript.question(a.views.get(id)))
	let first = transcript.question(a.views.get(id))!
	a.conn.send({ type: 'pause', sessionId: id })
	await until(() => a.of('turn-end').length)
	expect(a.of('turn-end')[0]).toMatchObject({ status: 'paused', usage: { input: 10, output: 5 } })
	a.conn.send({ type: 'continue', sessionId: id })
	await until(() => transcript.question(a.views.get(id)))
	let again = transcript.question(a.views.get(id))!
	expect(again.id).not.toBe(first.id)
	expect(calls).toHaveLength(1)
	a.conn.send({ type: 'answer', sessionId: id, question: again.id, answers: { run: 'yes' } })
	await until(() => calls.length === 2)
	expect(ran).toEqual(['b1'])
	expect(results(calls[1]!)).toEqual([expect.objectContaining({ id: 'b1', output: expect.stringMatching(/exit 0/) })])
})

