import { afterEach, expect, test } from 'bun:test'
import { auth, type Credential } from '../auth.ts'
import { createCompatProvider, openai, openaiProvider } from './openai.ts'
import { providerShared } from './shared.ts'

interface FetchCall {
	url: string
	init?: RequestInit
}

const origFetch = globalThis.fetch
const origGetCredential = auth.getCredential
const origGetEntry = auth.getEntry
const origEnsureFresh = auth.ensureFresh
const origWebSocket = globalThis.WebSocket
const origTransportEnv = process.env.HAL_OPENAI_RESPONSES_TRANSPORT
const origMarkCooldown = auth.markCooldown
const origHasAvailableCredential = auth.hasAvailableCredential
const origStreamTimeoutMs = providerShared.config.streamTimeoutMs
const origResponsesConnectTimeoutMs = openai.config.responsesConnectTimeoutMs

afterEach(() => {
	globalThis.fetch = origFetch
	auth.getCredential = origGetCredential
	auth.getEntry = origGetEntry
	auth.ensureFresh = origEnsureFresh
	auth.markCooldown = origMarkCooldown
	auth.hasAvailableCredential = origHasAvailableCredential
	globalThis.WebSocket = origWebSocket
	providerShared.config.streamTimeoutMs = origStreamTimeoutMs
	openai.config.responsesConnectTimeoutMs = origResponsesConnectTimeoutMs
	if (origTransportEnv == null) delete process.env.HAL_OPENAI_RESPONSES_TRANSPORT
	else process.env.HAL_OPENAI_RESPONSES_TRANSPORT = origTransportEnv
	openai.resetResponsesWebSocketsForTests()
})

test('resetSession closes the cached websocket chain for one session', () => {
	let closed = 0
	openai.state.webSockets.set('s1', { ws: { close: () => { closed++ } } } as any)
	openai.state.webSockets.set('s2', { ws: { close: () => { closed++ } } } as any)

	openai.resetSession('s1')

	expect(closed).toBe(1)
	expect(openai.state.webSockets.has('s1')).toBe(false)
	expect(openai.state.webSockets.has('s2')).toBe(true)
})

function encodeBase64Url(text: string): string {
	return Buffer.from(text)
		.toString('base64')
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/g, '')
}

function makeJwt(payload: Record<string, any>): string {
	return [
		encodeBase64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })),
		encodeBase64Url(JSON.stringify(payload)),
		'sig',
	].join('.')
}

function installFetchMock(fn: (input: any, init?: RequestInit) => Promise<Response>): void {
	process.env.HAL_OPENAI_RESPONSES_TRANSPORT = 'http'
	globalThis.fetch = Object.assign(fn, { preconnect: () => {} }) as typeof fetch
}

function responsesSse(): string {
	return [
		'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message"}}',
		'data: {"type":"response.output_text.delta","delta":"hello"}',
		'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":3,"output_tokens":4}}}',
		'',
	].join('\n')
}

function chatCompletionsSse(): string {
	return [
		'data: {"choices":[{"delta":{"content":"hello"}}]}',
		'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":6}}',
		'data: [DONE]',
		'',
	].join('\n')
}

async function collect(provider: { generate: typeof openaiProvider.generate }, providerName: string, credential: Credential, calls: FetchCall[]): Promise<any[]> {
	auth.ensureFresh = async () => {}
	auth.getCredential = (name: string) => (name === providerName ? credential : undefined)
	auth.getEntry = (name: string) => (name === providerName ? { accountId: 'acct_123' } : {})

	installFetchMock(async (input, init) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
		calls.push({ url, init })
		if (url.includes('/chat/completions')) {
			return new Response(chatCompletionsSse(), {
				status: 200,
				headers: { 'content-type': 'text/event-stream' },
			}) as any
		}
		if (url.includes('/responses')) {
			return new Response(responsesSse(), {
				status: 200,
				headers: { 'content-type': 'text/event-stream' },
			}) as any
		}
		throw new Error(`Unexpected URL: ${url}`)
	})

	const events: any[] = []
	for await (const event of provider.generate({
		messages: [{ role: 'user', content: 'hi' }],
		model: 'gpt-5.3-codex',
		systemPrompt: 'system',
		tools: [],
		sessionId: 'sid_123',
	})) {
		events.push(event)
	}
	return events
}

test('openai provider routes ChatGPT OAuth tokens to the Codex backend', async () => {
	const token = makeJwt({
		scp: ['openid', 'profile', 'email', 'offline_access'],
		'https://api.openai.com/auth': { chatgpt_account_id: 'acct_from_token' },
	})
	const calls: FetchCall[] = []
	const events = await collect(openaiProvider, 'openai', { value: token, type: 'token' }, calls)

	expect(calls).toHaveLength(1)
	expect(calls[0]!.url).toBe('https://chatgpt.com/backend-api/codex/responses')

	const headers = new Headers(calls[0]!.init?.headers)
	expect(headers.get('authorization')).toBe(`Bearer ${token}`)
	expect(headers.get('openai-beta')).toBe('responses=experimental')
	expect(headers.get('originator')).toBe('pi')
	expect(headers.get('chatgpt-account-id')).toBe('acct_from_token')

	expect(events).toContainEqual({ type: 'text', text: 'hello' })
	expect(events).toContainEqual(expect.objectContaining({ type: 'done', provider: 'openai', doneStatus: 'completed', usage: { input: 3, output: 4, cacheRead: 0, cacheCreation: 0 } }))
})

test('openai provider routes API keys to the public Responses API', async () => {
	const calls: FetchCall[] = []
	const events = await collect(openaiProvider, 'openai', { value: 'sk-test', type: 'api-key' }, calls)

	expect(calls).toHaveLength(1)
	expect(calls[0]!.url).toBe('https://api.openai.com/v1/responses')

	const headers = new Headers(calls[0]!.init?.headers)
	expect(headers.get('authorization')).toBe('Bearer sk-test')
	expect(headers.has('openai-beta')).toBe(false)
	expect(headers.has('originator')).toBe(false)
	expect(headers.has('chatgpt-account-id')).toBe(false)

	expect(events).toContainEqual({ type: 'text', text: 'hello' })
	expect(events).toContainEqual(expect.objectContaining({ type: 'done', provider: 'openai', doneStatus: 'completed', usage: { input: 3, output: 4, cacheRead: 0, cacheCreation: 0 } }))
})

test('compat providers stay on chat completions endpoints', async () => {
	const calls: FetchCall[] = []
	const provider = createCompatProvider('openrouter')
	const events = await collect(provider, 'openrouter', { value: 'sk-or-test', type: 'api-key' }, calls)

	expect(calls).toHaveLength(1)
	expect(calls[0]!.url).toBe('https://openrouter.ai/api/v1/chat/completions')

	const headers = new Headers(calls[0]!.init?.headers)
	expect(headers.get('authorization')).toBe('Bearer sk-or-test')
	expect(headers.has('openai-beta')).toBe(false)

	const body = JSON.parse(String(calls[0]!.init?.body ?? '{}'))
	expect(body.messages).toEqual([
		{ role: 'system', content: 'system' },
		{ role: 'user', content: 'hi' },
	])
	expect(body.input).toBeUndefined()

	expect(events).toContainEqual({ type: 'text', text: 'hello' })
	expect(events).toContainEqual(expect.objectContaining({ type: 'done', provider: 'openai', doneStatus: 'completed', usage: { input: 5, output: 6, cacheRead: 0, cacheCreation: 0 } }))
})

test('google compat provider asks for GOOGLE_API_KEY only', async () => {
	auth.ensureFresh = async () => {}
	auth.getCredential = () => undefined

	const events: any[] = []
	for await (const event of createCompatProvider('google').generate({
		messages: [{ role: 'user', content: 'hi' }],
		model: 'google/gemini-3.5-flash',
		systemPrompt: 'system',
		tools: [],
	})) {
		events.push(event)
	}

	expect(events[0]).toEqual({ type: 'error', message: "No credentials for 'google'. Set GOOGLE_API_KEY" })
	expect(events[0].message).not.toContain('login-openai')
	expect(events.at(-1)?.type).toBe('error')
})


test('openai provider reports the active account while rotating', async () => {
	const calls: FetchCall[] = []
	const events = await collect(openaiProvider, 'openai', {
		value: 'sk-test',
		type: 'api-key',
		email: 'first@test.com',
		index: 0,
		total: 3,
	}, calls)

	expect(events[0]).toEqual({
		type: 'status',
		activity: 'OpenAI 1/3 · first@test.com',
	})
	expect(events).toContainEqual({ type: 'text', text: 'hello' })
})


test('openai 429 shows failed and next account when another account is available', async () => {
	const credential: Credential = { value: 'sk-test', type: 'api-key', email: 'burned@test.com', _key: 'openai:0', index: 0, total: 3 }
	const next: Credential = { value: 'sk-next', type: 'api-key', email: 'next@test.com', _key: 'openai:1', index: 1, total: 3 }
	let cooldownMs = 0
	let cooldownCred: Credential | undefined
	let getCount = 0
	auth.ensureFresh = async () => {}
	auth.getCredential = () => (++getCount === 1 ? credential : next)
	auth.getEntry = () => ({})
	auth.markCooldown = (cred: Credential, ms: number) => {
		cooldownCred = cred
		cooldownMs = ms
	}
	auth.hasAvailableCredential = () => true
	installFetchMock(async () => new Response(JSON.stringify({ error: { resets_in_seconds: 2064 } }), { status: 429 }) as any)

	const events: any[] = []
	for await (const event of openaiProvider.generate({
		messages: [{ role: 'user', content: 'hi' }],
		model: 'gpt-5.3-codex',
		systemPrompt: 'system',
		tools: [],
		sessionId: 'sid_123',
	})) {
		events.push(event)
	}

	expect(cooldownCred).toBe(credential)
	expect(cooldownMs).toBe(2_064_000)
	expect(events[0]).toEqual({ type: 'status', activity: 'OpenAI 1/3 · burned@test.com' })
	expect(events[1]).toMatchObject({
		type: 'error',
		message: 'OpenAI rotation: 3 accounts. 429 on burned@test.com. Trying next@test.com next.',
		status: 429,
		retryAfterMs: 1_000,
	})
	expect(events.at(-1)?.type).toBe('error')
})

test('openai 429 waits for reset when all accounts are on cooldown', async () => {
	const credential: Credential = { value: 'sk-test', type: 'api-key', email: 'burned@test.com', _key: 'openai:0', index: 0, total: 3 }
	const next: Credential = { value: 'sk-next', type: 'api-key', email: 'next@test.com', _key: 'openai:1', index: 1, total: 3 }
	let cooldownMs = 0
	let getCount = 0
	auth.ensureFresh = async () => {}
	auth.getCredential = () => (++getCount === 1 ? credential : next)
	auth.getEntry = () => ({})
	auth.markCooldown = (_cred: Credential, ms: number) => {
		cooldownMs = ms
	}
	auth.hasAvailableCredential = () => false
	installFetchMock(async () => new Response(JSON.stringify({ error: { resets_in_seconds: 2064 } }), { status: 429 }) as any)

	const events: any[] = []
	for await (const event of openaiProvider.generate({
		messages: [{ role: 'user', content: 'hi' }],
		model: 'gpt-5.3-codex',
		systemPrompt: 'system',
		tools: [],
		sessionId: 'sid_123',
	})) {
		events.push(event)
	}

	expect(cooldownMs).toBe(2_064_000)
	expect(events[0]).toEqual({ type: 'status', activity: 'OpenAI 1/3 · burned@test.com' })
	expect(events[1]).toMatchObject({
		type: 'error',
		message: 'OpenAI rotation: 3 accounts. 429 on burned@test.com. All accounts cooling down. Next: next@test.com in 2064s.',
		status: 429,
		retryAfterMs: 2_064_000,
	})
})

function reasoningSse(): string {
	return [
		'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning"}}',
		'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"reasoning","id":"rs_123","encrypted_content":"secret","summary":[{"type":"summary_text","text":"duplicate"}]}}',
		'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":1,"output_tokens":2}}}',
		'',
	].join('\n')
}

test('openai provider minimizes reasoning signatures before emitting them', async () => {
	const token = makeJwt({
		scp: ['openid', 'profile', 'email', 'offline_access'],
		'https://api.openai.com/auth': { chatgpt_account_id: 'acct_from_token' },
	})
	auth.ensureFresh = async () => {}
	auth.getCredential = (name: string) => (name === 'openai' ? { value: token, type: 'token' } : undefined)
	auth.getEntry = () => ({})

	installFetchMock(async () => new Response(reasoningSse(), {
		status: 200,
		headers: { 'content-type': 'text/event-stream' },
	}) as any)

	const events: any[] = []
	for await (const event of openaiProvider.generate({
		messages: [{ role: 'user', content: 'hi' }],
		model: 'gpt-5.3-codex',
		systemPrompt: 'system',
		tools: [],
		sessionId: 'sid_123',
	})) {
		events.push(event)
	}

	expect(events).toContainEqual({
		type: 'thinking_signature',
		signature: JSON.stringify({ type: 'reasoning', id: 'rs_123', encrypted_content: 'secret' }),
	})
})

test('openai provider rehydrates minimized reasoning signatures with summary text during replay', () => {
	const input = openai.convertResponsesMessages([
		{
			role: 'assistant',
			content: [{
				type: 'thinking',
				thinking: 'previous reasoning summary',
				signature: JSON.stringify({ type: 'reasoning', id: 'rs_prev', encrypted_content: 'enc_prev' }),
			}],
		},
	] as any)

	expect(input).toContainEqual({
		type: 'reasoning',
		id: 'rs_prev',
		encrypted_content: 'enc_prev',
		summary: [{ type: 'summary_text', text: 'previous reasoning summary' }],
	})
})

test('openai provider preserves stored reasoning summaries during replay', () => {
	const input = openai.convertResponsesMessages([
		{
			role: 'assistant',
			content: [{
				type: 'thinking',
				thinking: 'fallback text',
				signature: JSON.stringify({
					type: 'reasoning',
					id: 'rs_prev',
					encrypted_content: 'enc_prev',
					summary: [{ type: 'summary_text', text: 'stored summary' }],
				}),
			}],
		},
	] as any)

	expect(input).toContainEqual({
		type: 'reasoning',
		id: 'rs_prev',
		encrypted_content: 'enc_prev',
		summary: [{ type: 'summary_text', text: 'stored summary' }],
	})
})


test('openai provider ignores malformed Responses SSE JSON lines', async () => {
	auth.ensureFresh = async () => {}
	auth.getCredential = () => ({ value: 'sk-test', type: 'api-key' })
	auth.getEntry = () => ({})

	installFetchMock(async () => new Response([
		'data: {not json}',
		'data: {"type":"response.output_text.delta","delta":"hello"}',
		'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":3,"output_tokens":4}}}',
		'',
	].join('\n'), {
		status: 200,
		headers: { 'content-type': 'text/event-stream' },
	}) as any)

	const events: any[] = []
	for await (const event of openaiProvider.generate({
		messages: [{ role: 'user', content: 'hi' }],
		model: 'gpt-5.3-codex',
		systemPrompt: 'system',
		tools: [],
		sessionId: 'sid_123',
	})) events.push(event)

	expect(events).toContainEqual({ type: 'text', text: 'hello' })
	expect(events).toContainEqual(expect.objectContaining({ type: 'done', provider: 'openai', doneStatus: 'completed', usage: { input: 3, output: 4, cacheRead: 0, cacheCreation: 0 } }))
})


test('openai Responses stream without response.completed does not emit done', async () => {
	auth.ensureFresh = async () => {}
	auth.getCredential = () => ({ value: 'sk-test', type: 'api-key' })
	auth.getEntry = () => ({})

	installFetchMock(async () => new Response([
		'data: {"type":"response.output_text.delta","delta":"partial"}',
		'',
	].join('\n'), {
		status: 200,
		headers: { 'content-type': 'text/event-stream' },
	}) as any)

	const events: any[] = []
	for await (const event of openaiProvider.generate({
		messages: [{ role: 'user', content: 'hi' }],
		model: 'gpt-5.3-codex',
		systemPrompt: 'system',
		tools: [],
		sessionId: 'sid_123',
	})) events.push(event)

	expect(events).toContainEqual({ type: 'text', text: 'partial' })
	expect(events.some((event) => event.type === 'done')).toBe(false)
})


test('compat provider reports tool JSON parse errors after [DONE] chunks', async () => {
	auth.ensureFresh = async () => {}
	auth.getCredential = () => ({ value: 'sk-or-test', type: 'api-key' })
	auth.getEntry = () => ({})
	const badToolDelta = JSON.stringify({
		choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'search', arguments: '{"bad":' } }] } }],
	})

	installFetchMock(async () => new Response([
		'data: {oops}',
		`data: ${badToolDelta}`,
		'data: {"choices":[{"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":5,"completion_tokens":6}}',
		'data: [DONE]',
		'',
	].join('\n'), {
		status: 200,
		headers: { 'content-type': 'text/event-stream' },
	}) as any)

	const events: any[] = []
	for await (const event of createCompatProvider('openrouter').generate({
		messages: [{ role: 'user', content: 'hi' }],
		model: 'gpt-5.3-codex',
		systemPrompt: 'system',
		tools: [],
		sessionId: 'sid_123',
	})) events.push(event)

	expect(events).toContainEqual({
		type: 'tool_call',
		id: 'call_1',
		name: 'search',
		input: {},
		parseError: 'Failed to parse tool input JSON (7 chars): {"bad":',
	})
	expect(events).toContainEqual(expect.objectContaining({ type: 'done', provider: 'openai', doneStatus: 'completed', usage: { input: 5, output: 6, cacheRead: 0, cacheCreation: 0 } }))
})

class FakeWebSocket {
	static instances: FakeWebSocket[] = []
	url: string
	options: any
	sent: any[] = []
	listeners = new Map<string, ((event: any) => void)[]>()
	readyState = 1

	constructor(url: string, options: any) {
		this.url = url
		this.options = options
		FakeWebSocket.instances.push(this)
		queueMicrotask(() => this.emit('open', {}))
	}

	addEventListener(name: string, cb: (event: any) => void): void {
		const list = this.listeners.get(name) ?? []
		list.push(cb)
		this.listeners.set(name, list)
	}

	send(raw: string): void {
		const body = JSON.parse(raw)
		this.sent.push(body)
		const id = `resp_${this.sent.length}`
		queueMicrotask(() => {
			this.message({ type: 'response.output_text.delta', delta: `text${this.sent.length}` })
			this.message({ type: 'response.completed', response: { id, status: 'completed', usage: { input_tokens: this.sent.length, output_tokens: 2 } } })
		})
	}

	close(): void {
		this.readyState = 3
	}

	message(event: any): void {
		this.emit('message', { data: JSON.stringify(event) })
	}

	emit(name: string, event: any): void {
		for (const cb of this.listeners.get(name) ?? []) cb(event)
	}
}

test('openai websocket transport uses wss endpoint and response.create', async () => {
	process.env.HAL_OPENAI_RESPONSES_TRANSPORT = 'ws'
	FakeWebSocket.instances = []
	globalThis.WebSocket = FakeWebSocket as any
	const token = makeJwt({
		scp: ['openid'],
		'https://api.openai.com/auth': { chatgpt_account_id: 'acct_ws' },
	})
	auth.ensureFresh = async () => {}
	auth.getCredential = () => ({ value: token, type: 'token' })
	auth.getEntry = () => ({})

	const events: any[] = []
	for await (const event of openaiProvider.generate({
		messages: [{ role: 'user', content: 'hi' }],
		model: 'gpt-5.5',
		systemPrompt: 'system',
		tools: [],
		sessionId: 'sid_ws',
	})) events.push(event)

	expect(FakeWebSocket.instances).toHaveLength(1)
	const ws = FakeWebSocket.instances[0]!
	expect(ws.url).toBe('wss://chatgpt.com/backend-api/codex/responses')
	expect(ws.options.headers['chatgpt-account-id']).toBe('acct_ws')
	expect(ws.sent[0]).toMatchObject({ type: 'response.create', model: 'gpt-5.5', store: false, instructions: 'system' })
	expect(ws.sent[0].stream).toBeUndefined()
	expect(events).toContainEqual({ type: 'text', text: 'text1' })
	expect(events).toContainEqual(expect.objectContaining({ type: 'done', provider: 'openai', doneStatus: 'completed', usage: { input: 1, output: 2, cacheRead: 0, cacheCreation: 0 } }))
})

class HangingWebSocket extends FakeWebSocket {
	override send(raw: string): void {
		this.sent.push(JSON.parse(raw))
	}
}
class NeverOpenWebSocket extends FakeWebSocket {
	override readyState = 0
	override emit(name: string, event: any): void {
		if (name === 'open') return
		super.emit(name, event)
	}
}

function setupOpenAiToken(): void {
	const token = makeJwt({
		scp: ['openid'],
		'https://api.openai.com/auth': { chatgpt_account_id: 'acct_ws' },
	})
	auth.ensureFresh = async () => {}
	auth.getCredential = () => ({ value: token, type: 'token' })
	auth.getEntry = () => ({})
}

test('openai auto transport falls back to HTTP when websocket connect times out', async () => {
	delete process.env.HAL_OPENAI_RESPONSES_TRANSPORT
	openai.config.responsesConnectTimeoutMs = 5
	FakeWebSocket.instances = []
	globalThis.WebSocket = NeverOpenWebSocket as any
	setupOpenAiToken()
	const calls: FetchCall[] = []
	globalThis.fetch = Object.assign(async (input: any, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
		calls.push({ url, init })
		return new Response(responsesSse(), { status: 200, headers: { 'content-type': 'text/event-stream' } }) as any
	}, { preconnect: () => {} }) as typeof fetch

	const events: any[] = []
	for await (const event of openaiProvider.generate({
		messages: [{ role: 'user', content: 'hi' }],
		model: 'gpt-5.5',
		systemPrompt: 'system',
		tools: [],
		sessionId: 'sid_ws_connect_timeout_auto',
	})) events.push(event)

	expect(FakeWebSocket.instances[0]!.readyState).toBe(3)
	expect(openai.state.webSockets.has('sid_ws_connect_timeout_auto')).toBe(false)
	expect(events).toContainEqual({ type: 'status', activity: 'OpenAI Responses WebSocket connect timed out (5ms); falling back to HTTP' })
	expect(calls).toHaveLength(1)
	expect(events).toContainEqual({ type: 'text', text: 'hello' })
	expect(events).toContainEqual(expect.objectContaining({ type: 'done', provider: 'openai', doneStatus: 'completed', usage: { input: 3, output: 4, cacheRead: 0, cacheCreation: 0 } }))
})

test('forced openai websocket transport reports connect timeout without fallback', async () => {
	process.env.HAL_OPENAI_RESPONSES_TRANSPORT = 'ws'
	openai.config.responsesConnectTimeoutMs = 5
	FakeWebSocket.instances = []
	globalThis.WebSocket = NeverOpenWebSocket as any
	setupOpenAiToken()

	const events: any[] = []
	for await (const event of openaiProvider.generate({
		messages: [{ role: 'user', content: 'hi' }],
		model: 'gpt-5.5',
		systemPrompt: 'system',
		tools: [],
		sessionId: 'sid_ws_connect_timeout_forced',
	})) events.push(event)

	expect(FakeWebSocket.instances[0]!.readyState).toBe(3)
	expect(openai.state.webSockets.has('sid_ws_connect_timeout_forced')).toBe(false)
	expect(events).toContainEqual({
		type: 'error',
		message: 'OpenAI Responses WebSocket connect timed out (5ms)',
		endpoint: 'wss://chatgpt.com/backend-api/codex/responses',
	})
	expect(events.some((event) => event.type === 'done')).toBe(false)
})

test('openai websocket transport times out when no events arrive', async () => {
	process.env.HAL_OPENAI_RESPONSES_TRANSPORT = 'ws'
	providerShared.config.streamTimeoutMs = 5
	FakeWebSocket.instances = []
	globalThis.WebSocket = HangingWebSocket as any
	const token = makeJwt({
		scp: ['openid'],
		'https://api.openai.com/auth': { chatgpt_account_id: 'acct_ws' },
	})
	auth.ensureFresh = async () => {}
	auth.getCredential = () => ({ value: token, type: 'token' })
	auth.getEntry = () => ({})

	const events: any[] = []
	const collect = (async () => {
		for await (const event of openaiProvider.generate({
			messages: [{ role: 'user', content: 'hi' }],
			model: 'gpt-5.5',
			systemPrompt: 'system',
			tools: [],
			sessionId: 'sid_ws_timeout',
		})) events.push(event)
	})()
	const result = await Promise.race([collect.then(() => 'done'), Bun.sleep(100).then(() => 'timeout')])

	expect(result).toBe('done')
	expect(events).toContainEqual({
		type: 'error',
		message: 'OpenAI Responses WebSocket timed out (no data for 5ms)',
		endpoint: 'wss://chatgpt.com/backend-api/codex/responses',
	})
	expect(events.some((event) => event.type === 'done')).toBe(false)
})

test('openai websocket continuation sends previous_response_id and only new tool output', async () => {
	process.env.HAL_OPENAI_RESPONSES_TRANSPORT = 'ws'
	FakeWebSocket.instances = []
	globalThis.WebSocket = FakeWebSocket as any
	auth.ensureFresh = async () => {}
	auth.getCredential = () => ({ value: 'sk-test', type: 'api-key' })
	auth.getEntry = () => ({})
	const firstMessages: any[] = [{ role: 'user', content: 'hi' }]
	const secondMessages: any[] = [
		...firstMessages,
		{ role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'bash', input: { command: 'echo hi' } }] },
		{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'hi' }] },
	]

	for await (const _ of openaiProvider.generate({ messages: firstMessages, model: 'gpt-5.5', systemPrompt: 'system', tools: [], sessionId: 'sid_chain' })) {}
	for await (const _ of openaiProvider.generate({ messages: secondMessages, model: 'gpt-5.5', systemPrompt: 'system', tools: [], sessionId: 'sid_chain' })) {}

	expect(FakeWebSocket.instances).toHaveLength(1)
	const sent = FakeWebSocket.instances[0]!.sent
	expect(sent).toHaveLength(2)
	expect(sent[1].previous_response_id).toBe('resp_1')
	expect(sent[1].input).toEqual([{ type: 'function_call_output', call_id: 'call_1', output: 'hi' }])
})
