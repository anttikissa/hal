// Shared setup for the host tests (host, turns and prompts): a fresh
// home per test, a scripted provider and clients that fold events into
// what they would show.

import { afterEach, beforeEach, expect } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import type { StreamEvent } from '../common/blocks.ts'
import { protocol, type Event } from '../common/protocol.ts'
import { transcript, type Item, type Transcript } from '../common/transcript.ts'
import { history } from './history.ts'
import { host } from './host.ts'
import { liveFiles } from './live-file.ts'
import { sessions } from './sessions.ts'
import { naming } from './naming.ts'
import { turns } from './turns.ts'

const savedHome = process.env.HAL_HOME
const origStream = turns.stream
const origOnError = liveFiles.onError
const origPrepare = naming.prepare
let home = ''

// The home directory of the running test.
export function testHome(): string {
	return home
}

// A scripted provider: each call waits for events pushed by the test,
// and ends as cancelled when its signal aborts, like provider.stream.
type Call = { model: string; input: any; push: (...e: StreamEvent[]) => void }
export const calls: Call[] = []

export function fakeStream(model: string, input: any, signal?: AbortSignal): AsyncIterable<StreamEvent> {
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

// Registers the hooks that give each test a fresh home and host.
export function useHost(withNaming = false): void {
	beforeEach(() => {
		home = mkdtempSync(`${tmpdir()}/hal-host-`)
		process.env.HAL_HOME = home
		liveFiles.onError = () => {}
		turns.stream = fakeStream
		// Unrelated exact-replay tests isolate title reminders, not user ownership.
		naming.prepare = withNaming ? origPrepare : () => {}
		calls.length = 0
	})

	afterEach(() => {
		host.reset()
		sessions.closeAll()
		turns.stream = origStream
		naming.prepare = origPrepare
		liveFiles.onError = origOnError
		if (savedHome === undefined) delete process.env.HAL_HOME
		else process.env.HAL_HOME = savedHome
		rmSync(home, { recursive: true, force: true })
	})
}

// A client that records events and folds them into what it would show.
export function client() {
	let events: Event[] = []
	let views = new Map<string, Transcript>()
	let conn = host.connect((e) => {
		// Every event the host sends passes the check clients make.
		expect(protocol.invalidEvent(e)).toBeUndefined()
		events.push(e)
		let id = 'sessionId' in e ? e.sessionId : undefined
		if (id) {
			let t = transcript.fold(views.get(id), e)
			if (t) views.set(id, t)
		}
	})
	return { conn, events, views, of: (type: string) => events.filter((e) => e.type === type) as any[] }
}

export async function until(check: () => unknown): Promise<void> {
	for (let i = 0; i < 200; i++) {
		if (check()) return
		await new Promise((r) => setTimeout(r, 1))
	}
	throw new Error('timed out')
}

export function created(c: ReturnType<typeof client>, cwd = '/tmp/w'): string {
	c.conn.send({ type: 'create', cwd, model: 'fake/m1' })
	let snap = c.of('snapshot').at(-1)
	return snap.sessionId
}

// What a client connecting now would see.
export async function fresh(id: string): Promise<Transcript> {
	let c = client()
	c.conn.send({ type: 'open', sessionId: id })
	await until(() => c.views.get(id))
	return c.views.get(id)!
}

// The host process goes away and a new one starts on the same home.
export function restartHost() {
	// As the exiting host does (host.init): output so far is written.
	history.stop(false)
	host.reset()
	sessions.closeAll()
}

// A prompt as replay sends it: its [HH:MM] line, then the text.
export const stamped = (text: string) => expect.stringMatching(new RegExp(`^\\[[\\d -]+:\\d\\d\\]\\n${text}$`))

// Items as shown, without their keys (task w5), for comparing with
// literals; a live transcript and a fresh one compare keys too.
// Items without key and header facts (time, model, effort: task hp),
// which tests of what happened need not repeat.
export const shown = (items: Item[] | undefined) => items?.map(({ key: _key, ...s }) => {
	let { ts: _ts, model: _model, effort: _effort, ...rest } = s as typeof s & { ts?: string; model?: string; effort?: string }
	return rest
})

export const records = async (id: string) => (await history.read(id)).map(({ ts: _ts, n: _n, ...r }) => r)

// A session whose cwd holds notes.txt, for the read tool.
export function toolSession(c: ReturnType<typeof client>): string {
	writeFileSync(`${testHome()}/notes.txt`, 'remember the milk\n')
	return created(c, testHome())
}

export const readCall = (id = 't1'): StreamEvent => ({ type: 'tool_call', id, name: 'read', input: { path: 'notes.txt' } })
