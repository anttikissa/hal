// Failures the host fixes by itself (tasks/j1/states.md, Failures):
// retrying and blocked, with a scripted provider and an injected clock.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import type { StreamEvent } from '../common/blocks.ts'
import type { Event } from '../common/protocol.ts'
import { replay } from '../common/replay.ts'
import { auth } from './auth.ts'
import { clock } from './clock.ts'
import { history } from './history.ts'
import { host } from './host.ts'
import { status } from './status.ts'
import { turns } from './turns.ts'
import { liveFiles } from './live-file.ts'
import { sessions } from './sessions.ts'

const savedHome = process.env.HAL_HOME
const orig = { stream: turns.stream, now: clock.now, sleep: clock.sleep, changed: auth.changed, onError: liveFiles.onError }
let home = ''
let now = 0
// Every wait the host asked the clock for, in ms.
let slept: number[] = []
// While set, sleeping blocks until aborted (a long wait the user ends).
let hold = false

// Each call answers with the next scripted list of events.
let script: StreamEvent[][] = []
let calls: { input: any }[] = []

function fakeStream(_model: string, input: any): AsyncIterable<StreamEvent> {
	calls.push({ input })
	let events = script.shift() ?? [{ type: 'done', reason: 'end' }]
	return (async function* () {
		yield* events
	})()
}

beforeEach(() => {
	home = mkdtempSync(`${tmpdir()}/hal-retry-`)
	process.env.HAL_HOME = home
	liveFiles.onError = () => {}
	turns.stream = fakeStream
	now = 1_800_000_000_000
	slept = []
	hold = false
	calls = []
	script = []
	clock.now = () => now
	clock.sleep = async (ms, signal) => {
		slept.push(ms)
		if (hold) return new Promise<void>((r) => signal?.addEventListener('abort', () => r()))
		now += ms
		await Bun.sleep(0)
	}
})

afterEach(() => {
	host.reset()
	sessions.closeAll()
	history.state.running.clear()
	Object.assign(host, { stream: orig.stream })
	Object.assign(clock, { now: orig.now, sleep: orig.sleep })
	auth.changed = orig.changed
	liveFiles.onError = orig.onError
	if (savedHome === undefined) delete process.env.HAL_HOME
	else process.env.HAL_HOME = savedHome
	rmSync(home, { recursive: true, force: true })
})

function client() {
	let events: Event[] = []
	let conn = host.connect((e) => events.push(e))
	let states = () => events.filter((e) => e.type === 'state').map((e: any) => e.state)
	return { conn, events, states, ends: () => events.filter((e) => e.type === 'turn-end') as any[] }
}

async function until(check: () => unknown): Promise<void> {
	for (let i = 0; i < 500; i++) {
		if (check()) return
		await Bun.sleep(1)
	}
	throw new Error('timed out')
}

function start(c: ReturnType<typeof client>): string {
	c.conn.send({ type: 'create', cwd: '/tmp/w', model: 'fake/m1' })
	let id = (c.events.find((e) => e.type === 'snapshot') as any).sessionId
	c.conn.send({ type: 'submit', sessionId: id, text: 'go' })
	return id
}

const dropped: StreamEvent = { type: 'error', message: 'fetch failed', failure: 'temporary' }
const done: StreamEvent[] = [{ type: 'text', text: 'ok' }, { type: 'done', reason: 'end' }]

test('a temporary failure retries at once, then backs off, and never gives up', async () => {
	let a = client()
	script = [[dropped], [dropped], [dropped], [dropped], [dropped], [dropped], [dropped], [dropped], [dropped], done]
	let id = start(a)
	await until(() => a.ends().length)
	expect(calls).toHaveLength(10)
	expect(a.ends()[0]).toMatchObject({ status: 'completed' })
	// Each retry shows when and why; the first is at once, later waits grow
	// but stay bounded.
	let retries = a.states().filter((s) => s.type === 'retrying')
	expect(retries).toHaveLength(9)
	expect(retries.every((s) => s.reason.includes('fetch failed'))).toBe(true)
	let gaps: number[] = []
	let t = 1_800_000_000_000
	for (let s of retries) {
		gaps.push(Date.parse(s.at) - t)
		t = Date.parse(s.at)
	}
	expect(gaps[0]).toBe(0)
	for (let i = 2; i < gaps.length; i++) expect(gaps[i]!).toBeGreaterThanOrEqual(gaps[i - 1]!)
	expect(gaps.at(-1)!).toBeGreaterThan(gaps[1]!)
	expect(Math.max(...gaps)).toBeLessThanOrEqual(60_000)
	expect(status.stateOf(id)).toEqual({ type: 'idle' })
	expect((await history.read(id)).filter((r) => r.type === 'turn_end')).toHaveLength(1)
})

test('a stream cut off mid-answer continues, and the model is told', async () => {
	let a = client()
	script = [[{ type: 'text', text: 'half' }, dropped], done]
	let id = start(a)
	await until(() => a.ends().length)
	let messages = calls[1]!.input.messages
	expect(messages.at(-2)).toEqual({ role: 'assistant', blocks: [{ type: 'text', text: 'half' }] })
	expect(JSON.stringify(messages.at(-1))).toContain(replay.continueNote)
	expect(status.stateOf(id).type).toBe('idle')
})

test('a rate limit waits for the time the provider gave, visible in snapshots; Escape pauses it', async () => {
	let a = client()
	let at = now + 3 * 3600_000
	script = [[{ type: 'error', message: 'HTTP 429 from fake: quota', status: 429, failure: 'limited', retryAt: at }]]
	hold = true
	let id = start(a)
	await until(() => status.stateOf(id).type === 'retrying')
	expect(status.stateOf(id)).toEqual({ type: 'retrying', at: new Date(at).toISOString(), reason: 'HTTP 429 from fake: quota' })
	let b = client()
	b.conn.send({ type: 'open', sessionId: id })
	expect((b.events.find((e) => e.type === 'snapshot') as any).snapshot.state).toMatchObject({ type: 'retrying', at: new Date(at).toISOString() })
	a.conn.send({ type: 'pause', sessionId: id })
	await until(() => a.ends().length)
	expect(a.ends()[0]).toMatchObject({ status: 'paused' })
	expect(status.stateOf(id)).toEqual({ type: 'paused' })
	expect(calls).toHaveLength(1)
})

test('a rotation to another account retries at once', async () => {
	let a = client()
	script = [[{ type: 'error', message: 'HTTP 429 from fake', status: 429, failure: 'limited', retryAt: now }], done]
	start(a)
	await until(() => a.ends().length)
	expect(calls).toHaveLength(2)
	expect(slept).toEqual([])
})

test('broken login blocks until the credentials file changes, then continues by itself', async () => {
	let a = client()
	let changed = () => {}
	auth.changed = (signal) => new Promise<void>((r) => ((changed = r), signal?.addEventListener('abort', () => r())))
	let login: StreamEvent = { type: 'error', message: 'auth.ason: refresh failed: invalid_grant', failure: 'auth' }
	script = [[login], done]
	let id = start(a)
	await until(() => status.stateOf(id).type === 'blocked')
	expect(status.stateOf(id)).toEqual({ type: 'blocked', reason: expect.stringMatching(/log in.*invalid_grant/) })
	expect(calls).toHaveLength(1)
	changed()
	await until(() => a.ends().length)
	expect(a.ends()[0]).toMatchObject({ status: 'completed' })
})

test('a rejected token (auth with a retry time) retries instead of blocking', async () => {
	let a = client()
	script = [[{ type: 'error', message: 'HTTP 401', status: 401, failure: 'auth', retryAt: now }], done]
	let id = start(a)
	await until(() => a.ends().length)
	expect(a.states().some((s) => s.type === 'blocked')).toBe(false)
	expect(status.stateOf(id).type).toBe('idle')
})

test('Escape while blocked pauses', async () => {
	let a = client()
	auth.changed = (signal) => new Promise<void>((r) => signal?.addEventListener('abort', () => r()))
	script = [[{ type: 'error', message: 'no credentials', failure: 'auth' }]]
	let id = start(a)
	await until(() => status.stateOf(id).type === 'blocked')
	a.conn.send({ type: 'pause', sessionId: id })
	await until(() => a.ends().length)
	expect(status.stateOf(id)).toEqual({ type: 'paused' })
})

test('a bad request ends the turn in error with the provider message; continue retries it', async () => {
	let a = client()
	script = [[{ type: 'error', message: 'HTTP 400 from fake: image input not supported', status: 400 }], done]
	let id = start(a)
	await until(() => a.ends().length)
	expect(status.stateOf(id)).toEqual({ type: 'error', message: 'HTTP 400 from fake: image input not supported' })
	expect(calls).toHaveLength(1)
	a.conn.send({ type: 'continue', sessionId: id })
	await until(() => a.ends().length === 2)
	expect(status.stateOf(id).type).toBe('idle')
	expect(calls[1]!.input.messages).toEqual(calls[0]!.input.messages)
})
