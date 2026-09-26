import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { StreamEvent } from '../common/blocks.ts'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { clock } from './clock.ts'
import { limits } from './limits.ts'
import { paths } from './paths.ts'
import { provider, type Provider, type ProviderRequest, type SseMessage } from './provider.ts'

// A response body whose chunks the test controls, to split SSE anywhere.
function body(chunks: string[]): ReadableStream<Uint8Array> {
	let enc = new TextEncoder()
	return new ReadableStream({
		pull(c) {
			let next = chunks.shift()
			if (next === undefined) c.close()
			else c.enqueue(enc.encode(next))
		},
	})
}

async function all<T>(it: AsyncIterable<T>): Promise<T[]> {
	let out: T[] = []
	for await (let x of it) out.push(x)
	return out
}

// Echo provider: every SSE data line is one JSON event, passed through.
const echo: Provider = {
	request: (req) => ({ url: `https://example.test/${req.model}`, headers: { 'x-key': 'k' }, body: { model: req.model, n: req.messages.length } }),
	async *parse(messages) {
		for await (let m of messages) yield JSON.parse(m.data) as StreamEvent
	},
}

const req: Omit<ProviderRequest, 'model'> = { messages: [{ role: 'user', blocks: [{ type: 'text', text: 'hi' }] }] }

let calls: { url: string; init: RequestInit }[] = []
function fakeFetch(res: () => Response | Promise<Response>) {
	calls = []
	provider.fetch = async (url, init) => {
		calls.push({ url, init })
		return res()
	}
}

function sse(...events: StreamEvent[]): string {
	return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')
}

const originalFetch = provider.fetch
const savedHome = process.env.HAL_HOME
const origNow = clock.now
let home = ''
let now = 1_800_000_000_000
beforeEach(() => {
	home = mkdtempSync(`${tmpdir()}/hal-provider-`)
	process.env.HAL_HOME = home
	paths.init()
	now = 1_800_000_000_000
	clock.now = () => now
})
afterEach(() => {
	provider.fetch = originalFetch
	provider.state.providers = {}
	limits.close()
	clock.now = origNow
	clock.state.listeners.clear()
	if (savedHome === undefined) delete process.env.HAL_HOME
	else process.env.HAL_HOME = savedHome
	rmSync(home, { recursive: true, force: true })
})

test('SSE framing survives arbitrary chunk boundaries', async () => {
	let text = ': comment\r\nevent: a\r\ndata: {"x":1}\r\n\r\ndata: line1\ndata: line2\n\nevent: b\ndata:no-space\n\ndata: [DONE]\n\ndata: tail'
	let expected: SseMessage[] = [
		{ event: 'a', data: '{"x":1}' },
		{ event: undefined, data: 'line1\nline2' },
		{ event: 'b', data: 'no-space' },
		{ event: undefined, data: '[DONE]' },
		{ event: undefined, data: 'tail' },
	]
	expect(await all(provider.sse(body([text])))).toEqual(expected)
	// Every split point, including inside \r\n and multi-byte characters.
	let bytes = new TextEncoder().encode(text + 'ä')
	for (let i = 1; i < bytes.length; i++) {
		let stream = new ReadableStream<Uint8Array>({
			start(c) {
				c.enqueue(bytes.slice(0, i))
				c.enqueue(bytes.slice(i))
				c.close()
			},
		})
		expect(await all(provider.sse(stream))).toEqual([...expected.slice(0, -1), { event: undefined, data: 'tailä' }])
	}
})

test('model id selects the registered provider and the request goes out as JSON', async () => {
	provider.register('fake', echo)
	fakeFetch(() => new Response(body([sse({ type: 'text', text: 'ok' }, { type: 'done', reason: 'end' })])))
	let events = await all(provider.stream('fake/m1', req))
	expect(events).toEqual([{ type: 'text', text: 'ok' }, { type: 'done', reason: 'end' }])
	expect(calls).toHaveLength(1)
	expect(calls[0]!.url).toBe('https://example.test/m1')
	expect(calls[0]!.init.method).toBe('POST')
	expect(new Headers(calls[0]!.init.headers).get('x-key')).toBe('k')
	expect(new Headers(calls[0]!.init.headers).get('content-type')).toBe('application/json')
	expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ model: 'm1', n: 1 })
})

test('unknown provider or malformed model id is an error, with no request', async () => {
	fakeFetch(() => new Response(''))
	for (let id of ['nope/m', 'no-slash']) {
		let events = await all(provider.stream(id, req))
		expect(events).toHaveLength(1)
		expect(events[0]!.type).toBe('error')
	}
	expect(calls).toHaveLength(0)
})

test('HTTP error status becomes one error event carrying status and body', async () => {
	provider.register('fake', echo)
	fakeFetch(() => new Response('{"error":"overloaded"}', { status: 529 }))
	let events = await all(provider.stream('fake/m1', req))
	expect(events).toHaveLength(1)
	expect(events[0]).toMatchObject({ type: 'error', status: 529, body: '{"error":"overloaded"}' })
})

test('network failure becomes an error event', async () => {
	provider.register('fake', echo)
	fakeFetch(() => Promise.reject(new Error('ECONNREFUSED')))
	let events = await all(provider.stream('fake/m1', req))
	expect(events).toHaveLength(1)
	expect(events[0]).toMatchObject({ type: 'error' })
	expect((events[0] as { message: string }).message).toContain('ECONNREFUSED')
})

test('a stream that ends without done gets an error; nothing follows a terminal event', async () => {
	provider.register('fake', echo)
	fakeFetch(() => new Response(body([sse({ type: 'text', text: 'partial' })])))
	let events = await all(provider.stream('fake/m1', req))
	expect(events.map((e) => e.type)).toEqual(['text', 'error'])

	fakeFetch(() => new Response(body([sse({ type: 'done', reason: 'end' }, { type: 'text', text: 'late' }, { type: 'error', message: 'x' })])))
	events = await all(provider.stream('fake/m1', req))
	expect(events).toEqual([{ type: 'done', reason: 'end' }])
})

test('a provider that throws while parsing yields an error, not an exception', async () => {
	provider.register('bad', {
		...echo,
		async *parse(messages) {
			for await (let m of messages) yield JSON.parse(m.data.slice(1)) as StreamEvent
		},
	})
	fakeFetch(() => new Response(body([sse({ type: 'text', text: 'x' })])))
	let events = await all(provider.stream('bad/m1', req))
	expect(events).toEqual([expect.objectContaining({ type: 'error', message: expect.stringContaining('JSON') })])
})

test('abort mid-stream ends with one cancelled error and stops reading', async () => {
	provider.register('fake', echo)
	let enc = new TextEncoder()
	let cancelled = false
	// Never closes on its own: only abort can end it.
	let stream = new ReadableStream<Uint8Array>({
		start(c) {
			c.enqueue(enc.encode(sse({ type: 'text', text: 'first' })))
		},
		cancel() {
			cancelled = true
		},
	})
	fakeFetch(() => new Response(stream))
	let ac = new AbortController()
	let events: StreamEvent[] = []
	for await (let e of provider.stream('fake/m1', req, ac.signal)) {
		events.push(e)
		// Abort while the next read is waiting for data.
		if (e.type === 'text') setTimeout(() => ac.abort(), 5)
	}
	expect(events).toEqual([{ type: 'text', text: 'first' }, expect.objectContaining({ type: 'error', cancelled: true })])
	expect(cancelled).toBe(true)
	expect(calls[0]!.init.signal?.aborted).toBe(true)
})

test('abort before the request is sent yields cancelled without fetching', async () => {
	provider.register('fake', echo)
	fakeFetch(() => new Response(''))
	let ac = new AbortController()
	ac.abort()
	let events = await all(provider.stream('fake/m1', req, ac.signal))
	expect(events).toEqual([expect.objectContaining({ type: 'error', cancelled: true })])
	expect(calls).toHaveLength(0)
})

test('a stalled stream times out as an error', async () => {
	provider.register('fake', echo)
	let original = provider.streamTimeoutMs
	provider.streamTimeoutMs = () => 20
	try {
		fakeFetch(() => new Response(new ReadableStream({ start() {} })))
		let events = await all(provider.stream('fake/m1', req))
		expect(events).toEqual([expect.objectContaining({ type: 'error', message: expect.stringContaining('timed out') })])
	} finally {
		provider.streamTimeoutMs = original
	}
})

// Failures say how the host can fix them: `failure` absent means it
// can't (a bad request ends the turn in error).
test('failures are classified by what fixes them, with the provider message', async () => {
	provider.register('fake', echo)
	let cases: [number, string | undefined][] = [
		[500, 'temporary'],
		[502, 'temporary'],
		[529, 'temporary'],
		[408, 'temporary'],
		[429, 'limited'],
		[401, 'auth'],
		[400, undefined],
		[404, undefined],
		[413, undefined],
	]
	for (let [status, failure] of cases) {
		fakeFetch(() => new Response('{"type":"error","error":{"type":"x","message":"prompt is too long"}}', { status }))
		let [e] = (await all(provider.stream('fake/m1', req))) as any[]
		expect([status, e.failure]).toEqual([status, failure])
		expect(e.message).toContain('prompt is too long')
	}
	fakeFetch(() => Promise.reject(new Error('ECONNRESET')))
	expect(await all(provider.stream('fake/m1', req))).toEqual([expect.objectContaining({ failure: 'temporary' })])
	// Cut off mid-stream, or an overloaded error inside the stream.
	fakeFetch(() => new Response(body([sse({ type: 'text', text: 'partial' })])))
	expect((await all(provider.stream('fake/m1', req))).at(-1)).toMatchObject({ failure: 'temporary' })
	fakeFetch(() => new Response(body([sse({ type: 'error', message: 'Overloaded', status: 529 })])))
	expect((await all(provider.stream('fake/m1', req))).at(-1)).toMatchObject({ failure: 'temporary' })
})

test('a bug in a provider is not retried', async () => {
	provider.register('bad', { ...echo, request: () => (undefined as any).x })
	fakeFetch(() => new Response(''))
	let [e] = (await all(provider.stream('bad/m1', req))) as any[]
	expect(e.failure).toBeUndefined()
	provider.register('bad2', {
		...echo,
		async *parse(messages) {
			for await (let m of messages) yield JSON.parse(m.data.slice(1)) as StreamEvent
		},
	})
	fakeFetch(() => new Response(body([sse({ type: 'text', text: 'x' })])))
	;[e] = (await all(provider.stream('bad2/m1', req))) as any[]
	expect(e.failure).toBeUndefined()
})

test('429 carries the reset time and the model is not asked again before it, even after a restart', async () => {
	provider.register('fake', echo)
	fakeFetch(() => new Response('{}', { status: 429, headers: { 'retry-after': '120' } }))
	let [e] = (await all(provider.stream('fake/m1', req))) as any[]
	expect(e).toMatchObject({ failure: 'limited', retryAt: now + 120_000 })
	limits.close()
	fakeFetch(() => new Response(body([sse({ type: 'done', reason: 'end' })])))
	;[e] = (await all(provider.stream('fake/m1', req))) as any[]
	expect(e).toMatchObject({ failure: 'limited', retryAt: now + 120_000 })
	expect(calls).toHaveLength(0)
	// Another model is not limited.
	expect(await all(provider.stream('fake/m2', req))).toEqual([{ type: 'done', reason: 'end' }])
	now += 120_000
	expect(await all(provider.stream('fake/m1', req))).toEqual([{ type: 'done', reason: 'end' }])
})

test('the reset time can come from a date, a unix time header or the body', async () => {
	provider.register('fake', echo)
	let cases: [ResponseInit, string, number][] = [
		[{ status: 429, headers: { 'retry-after': new Date(now + 60_000).toUTCString() } }, '{}', now + 60_000],
		[{ status: 429, headers: { 'anthropic-ratelimit-unified-reset': String((now + 3 * 3600_000) / 1000) } }, '{}', now + 3 * 3600_000],
		[{ status: 429 }, '{"error":{"type":"usage_limit_reached","resets_in_seconds":7200}}', now + 7200_000],
		[{ status: 429 }, `{"error":{"resets_at":${(now + 5000_000) / 1000}}}`, now + 5000_000],
	]
	for (let [i, [init, text, at]] of cases.entries()) {
		fakeFetch(() => new Response(text, init))
		let [e] = (await all(provider.stream(`fake/m${i}`, req))) as any[]
		expect(e.retryAt).toBe(at)
	}
})

test('an account that hits 429 is limited, and the host may rotate at once', async () => {
	provider.register('fake', { ...echo, request: (r) => ({ ...(echo.request(r) as any), account: 'a@x' }) })
	fakeFetch(() => new Response('{}', { status: 429, headers: { 'retry-after': '3600' } }))
	let [e] = (await all(provider.stream('fake/m1', req))) as any[]
	expect(e).toMatchObject({ failure: 'limited', retryAt: now })
	expect(limits.until(limits.key('fake/m1', 'a@x'))).toBe(now + 3600_000)
})

test('a 401 tells the provider which account was rejected', async () => {
	let rejected: string[] = []
	provider.register('fake', { ...echo, request: (r) => ({ ...(echo.request(r) as any), account: 'a@x' }), rejected: (a) => void rejected.push(a) })
	fakeFetch(() => new Response('{}', { status: 401 }))
	let [e] = (await all(provider.stream('fake/m1', req))) as any[]
	expect(e.failure).toBe('auth')
	expect(rejected).toEqual(['a@x'])
})

test('errors thrown while building the request keep their failure and reset time', async () => {
	provider.register('fake', {
		...echo,
		request: () => {
			throw Object.assign(new Error('every account is rate limited'), { failure: 'limited', retryAt: now + 1000 })
		},
	})
	fakeFetch(() => new Response(''))
	expect(await all(provider.stream('fake/m1', req))).toEqual([expect.objectContaining({ failure: 'limited', retryAt: now + 1000 })])
	expect(calls).toHaveLength(0)
})

// Laptop sleep: a stream open across it is dropped, not waited on.
test('a wake drops the open stream as a temporary failure, not a cancel', async () => {
	provider.register('fake', echo)
	let enc = new TextEncoder()
	fakeFetch(() => new Response(new ReadableStream({ start: (c) => c.enqueue(enc.encode(sse({ type: 'text', text: 'first' }))) })))
	let events: StreamEvent[] = []
	for await (let e of provider.stream('fake/m1', req)) {
		events.push(e)
		if (e.type === 'text') setTimeout(() => clock.wake(), 5)
	}
	expect(events.at(-1)).toMatchObject({ type: 'error', failure: 'temporary' })
	expect((events.at(-1) as any).cancelled).toBeUndefined()
	expect(clock.state.listeners.size).toBe(0)
})
