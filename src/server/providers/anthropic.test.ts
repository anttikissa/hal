import { afterEach, beforeEach, expect, test } from 'bun:test'
import { auth, type Credential } from '../auth.ts'
import { anthropicUsage } from '../anthropic-usage.ts'
import { anthropicProvider } from './anthropic.ts'
import { version } from '../version.ts'
import { blob } from '../session/blob.ts'

const origFetch = globalThis.fetch
const origGetCredential = auth.getCredential
const origEnsureFresh = auth.ensureFresh
const origMarkCooldown = auth.markCooldown
const origHasAvailableCredential = auth.hasAvailableCredential
const origRefreshUsage = anthropicUsage.refreshAll

const origCombined = version.state.combined
const origWriteRawProviderOutput = blob.writeRawProviderOutput

beforeEach(() => {
	anthropicUsage.refreshAll = async () => []
})

afterEach(() => {
	globalThis.fetch = origFetch
	version.state.combined = origCombined
	auth.getCredential = origGetCredential
	auth.ensureFresh = origEnsureFresh
	auth.markCooldown = origMarkCooldown
	auth.hasAvailableCredential = origHasAvailableCredential
	anthropicUsage.refreshAll = origRefreshUsage
	blob.writeRawProviderOutput = origWriteRawProviderOutput
})

function installFetchMock(fn: (input: any, init?: RequestInit) => Promise<Response>): void {
	globalThis.fetch = Object.assign(fn, { preconnect: () => {} }) as typeof fetch
}

function anthropicSse(): string {
	return [
		'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}',
		'data: {"type":"message_delta","usage":{"output_tokens":4}}',
		'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null}}',
		'data: {"type":"message_stop"}',
		'',
	].join('\n')
}

async function collect(credential: Credential, model = 'claude-sonnet-4-5'): Promise<any[]> {
	auth.ensureFresh = async () => {}
	auth.getCredential = () => credential

	const events: any[] = []
	for await (const event of anthropicProvider.generate({
		messages: [{ role: 'user', content: 'hi' }],
		model,
		systemPrompt: 'system',
		tools: [],
		sessionId: 'sid_123',
	})) {
		events.push(event)
	}
	return events
}

test('anthropic provider streams text while rotating accounts', async () => {
	installFetchMock(async () => new Response(anthropicSse(), {
		status: 200,
		headers: { 'content-type': 'text/event-stream' },
	}) as any)

	const events = await collect({
		value: 'tok-test',
		type: 'token',
		email: 'first@test.com',
		index: 0,
		total: 3,
	})

	expect(events[0]).toEqual({ type: 'text', text: 'hello' })
	expect(events.at(-1)).toMatchObject({ type: 'done', doneStatus: 'completed', usage: { input: 0, output: 4, cacheRead: 0, cacheCreation: 0 } })
})

test('completed Anthropic responses refresh the existing usage cache', async () => {
	let refreshes = 0
	anthropicUsage.refreshAll = async () => {
		refreshes++
		return []
	}
	installFetchMock(async () => new Response(anthropicSse(), { status: 200 }) as any)

	await collect({ value: 'tok-test', type: 'token' })
	await Promise.resolve()

	expect(refreshes).toBe(1)
})

test('Anthropic uses adaptive thinking for current models on both credential paths', async () => {
	let body: any
	installFetchMock(async (_input, init) => {
		body = JSON.parse(String(init?.body))
		return new Response(anthropicSse(), { status: 200 })
	})
	const adaptiveModels = ['claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-fable-5-1', 'claude-fable-5', 'claude-sonnet-5', 'claude-sonnet-4-6']
	for (const model of adaptiveModels) {
		for (const type of ['api-key', 'token'] as const) {
			await collect({ value: 'tok-test', type }, model)
			expect(body.thinking).toEqual({ type: 'adaptive' })
		}
	}
	await collect({ value: 'tok-test', type: 'api-key' })
	expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 10000 })
})

test('anthropic network errors include Bun error code details', async () => {
	const cause: any = new Error('connect ECONNREFUSED 127.0.0.1:443')
	cause.code = 'ECONNREFUSED'
	cause.syscall = 'connect'
	cause.address = '127.0.0.1'
	cause.port = 443
	const err: any = new Error('fetch failed')
	err.cause = cause
	installFetchMock(async () => { throw err })
	auth.ensureFresh = async () => {}
	auth.getCredential = () => ({ value: 'tok-test', type: 'token' })

	const events: any[] = []
	for await (const event of anthropicProvider.generate({
		messages: [{ role: 'user', content: 'hi' }],
		model: 'claude-sonnet-4-5',
		systemPrompt: 'system',
		tools: [],
		sessionId: 'sid_network',
	})) events.push(event)

	expect(events[0]).toMatchObject({ type: 'error', endpoint: 'https://api.anthropic.com/v1/messages?beta=true' })
	expect(events[0].message).toContain('fetch failed')
	expect(events[0].message).toContain('code=ECONNREFUSED')
	expect(events[0].message).toContain('syscall=connect')
})

test('anthropic oauth 401 tells user to log in again', async () => {
	installFetchMock(async () => new Response(JSON.stringify({ error: { type: 'authentication_error' } }), {
		status: 401,
	}) as any)

	const events = await collect({ value: 'tok-test', type: 'token' })

	expect(events[0]).toMatchObject({ type: 'error', status: 401 })
	expect(events[0].message).toContain('/login claude')
})

test('anthropic 429 shows failed and next account when another account is available', async () => {
	const credential: Credential = { value: 'tok-test', type: 'token', email: 'burned@test.com', _key: 'anthropic:0', index: 0, total: 3 }
	const next: Credential = { value: 'tok-next', type: 'token', email: 'next@test.com', _key: 'anthropic:1', index: 1, total: 3 }
	let cooldownMs = 0
	let cooldownCred: Credential | undefined
	let getCount = 0

	auth.ensureFresh = async () => {}
	auth.getCredential = () => (++getCount === 1 ? credential : next)
	auth.markCooldown = (cred: Credential, ms: number) => {
		cooldownCred = cred
		cooldownMs = ms
	}
	auth.hasAvailableCredential = () => true
	installFetchMock(async () => new Response(JSON.stringify({ error: { type: 'rate_limit_error', message: 'too many requests' } }), {
		status: 429,
		headers: { 'retry-after': '42' },
	}) as any)

	const events: any[] = []
	for await (const event of anthropicProvider.generate({
		messages: [{ role: 'user', content: 'hi' }],
		model: 'claude-sonnet-4-5',
		systemPrompt: 'system',
		tools: [],
		sessionId: 'sid_123',
	})) {
		events.push(event)
	}

	expect(cooldownCred).toBe(credential)
	expect(cooldownMs).toBe(42_000)
	expect(events[0]).toMatchObject({
		type: 'error',
		message: 'Anthropic rotation: 3 accounts. 429 on burned@test.com. Trying next@test.com next.',
		status: 429,
		retryAfterMs: 1_000,
	})
	expect(events.at(-1)?.type).toBe('error')
})

test('anthropic 429 waits for reset when all accounts are on cooldown', async () => {
	const credential: Credential = { value: 'tok-test', type: 'token', email: 'burned@test.com', _key: 'anthropic:0', index: 0, total: 3 }
	const next: Credential = { value: 'tok-next', type: 'token', email: 'next@test.com', _key: 'anthropic:1', index: 1, total: 3 }
	let cooldownMs = 0
	let getCount = 0

	auth.ensureFresh = async () => {}
	auth.getCredential = () => (++getCount === 1 ? credential : next)
	auth.markCooldown = (_cred: Credential, ms: number) => {
		cooldownMs = ms
	}
	auth.hasAvailableCredential = () => false
	installFetchMock(async () => new Response(JSON.stringify({ error: { type: 'rate_limit_error', message: 'too many requests' } }), {
		status: 429,
		headers: { 'retry-after': '42' },
	}) as any)

	const events: any[] = []
	for await (const event of anthropicProvider.generate({
		messages: [{ role: 'user', content: 'hi' }],
		model: 'claude-sonnet-4-5',
		systemPrompt: 'system',
		tools: [],
		sessionId: 'sid_123',
	})) {
		events.push(event)
	}

	expect(cooldownMs).toBe(42_000)
	expect(events[0]).toMatchObject({
		type: 'error',
		message: 'Anthropic rotation: 3 accounts. 429 on burned@test.com. All accounts cooling down. Next: next@test.com in 42s.',
		status: 429,
		retryAfterMs: 42_000,
	})
})

test('anthropic stream without message_stop does not emit done', async () => {
	installFetchMock(async () => new Response([
		'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}',
		'data: {"type":"message_delta","usage":{"output_tokens":2}}',
		'',
	].join('\n'), {
		status: 200,
		headers: { 'content-type': 'text/event-stream' },
	}) as any)

	const events = await collect({ value: 'tok-test', type: 'token' })
	expect(events).toContainEqual({ type: 'text', text: 'partial' })
	expect(events.some((event) => event.type === 'done')).toBe(false)
})

test('anthropic provider surfaces refusal stop details instead of an empty response', async () => {
	const stopDetails = {
		type: 'refusal',
		category: 'cyber',
		explanation: 'This request triggered restrictions on violative cyber content.',
	}
	installFetchMock(async () => new Response([
		`data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'refusal', stop_details: stopDetails }, usage: { output_tokens: 0 } })}`,
		'data: {"type":"message_stop"}',
		'',
	].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } }) as any)

	const events = await collect({ value: 'tok-test', type: 'token' })
	expect(events[0]).toEqual({
		type: 'error',
		message: `Claude refused the request: ${stopDetails.explanation}`,
		body: JSON.stringify({ stop_reason: 'refusal', stop_details: stopDetails }),
	})
	expect(events.at(-1)?.type).toBe('done')
})

test('anthropic provider surfaces max_tokens truncation instead of an empty response', async () => {
	installFetchMock(async () => new Response([
		'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tool_1","name":"write","input":{}}}',
		'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\": "}}',
		'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":16384}}',
		'data: {"type":"message_stop"}',
		'',
	].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } }) as any)

	const events = await collect({ value: 'tok-test', type: 'token' })
	expect(events.find((event) => event.type === 'error')?.message).toContain('output token limit')
})

test('anthropic provider ignores malformed SSE JSON lines', async () => {
	installFetchMock(async () => new Response([
		'data: {not json}',
		'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}',
		'data: {"type":"message_delta","usage":{"output_tokens":4}}',
		'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
		'data: {"type":"message_stop"}',
		'',
	].join('\n'), {
		status: 200,
		headers: { 'content-type': 'text/event-stream' },
	}) as any)

	const events = await collect({ value: 'tok-test', type: 'token' })
	expect(events).toContainEqual({ type: 'text', text: 'hello' })
	expect(events.at(-1)).toMatchObject({ type: 'done', doneStatus: 'completed', usage: { input: 0, output: 4, cacheRead: 0, cacheCreation: 0 } })
})

test('preserves raw SSE lines for tool-input forensics', async () => {
	const raw = [
		'data: {not json}',
		'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tool_1","name":"bash","input":{}}}',
		'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\": "}}',
		'data: {"type":"content_block_stop","index":0}',
		'data: {"type":"message_stop"}',
		'',
	].join('\n')
	let captured: { sessionId: string; provider: string; text: string } | undefined
	blob.writeRawProviderOutput = async (sessionId, provider, text) => { captured = { sessionId, provider, text } }
	installFetchMock(async () => new Response(raw, { status: 200, headers: { 'content-type': 'text/event-stream' } }) as any)

	await collect({ value: 'tok-test', type: 'token' })

	expect(captured).toEqual({ sessionId: 'sid_123', provider: 'anthropic', text: raw })
})

test('anthropic provider streams web_search use and result at block stops', async () => {
	installFetchMock(async () => new Response([
		'data: {"type":"content_block_start","index":0,"content_block":{"type":"server_tool_use","id":"srvtoolu_1","name":"web_search","input":{}}}',
		'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\": \\"news.ycombinator.com top story"}}',
		'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":" today\\"}"}}',
		'data: {"type":"content_block_stop","index":0}',
		'data: {"type":"content_block_start","index":1,"content_block":{"type":"web_search_tool_result","tool_use_id":"srvtoolu_1","content":[{"type":"web_search_result","title":"HN","url":"https://news.ycombinator.com/"}]}}',
		'data: {"type":"content_block_stop","index":1}',
		'data: {"type":"message_stop"}',
		'',
	].join('\n'), {
		status: 200,
		headers: { 'content-type': 'text/event-stream' },
	}) as any)

	const events = await collect({ value: 'tok-test', type: 'token' })
	const serverTools = events.filter((event) => event.type === 'server_tool')
	expect(serverTools).toHaveLength(2)
	expect(serverTools[0].serverBlocks[0]).toMatchObject({
		type: 'server_tool_use',
		name: 'web_search',
		input: { query: 'news.ycombinator.com top story today' },
	})
	expect(serverTools[1].serverBlocks[0]).toMatchObject({
		type: 'web_search_tool_result',
		tool_use_id: 'srvtoolu_1',
		content: [{ title: 'HN', url: 'https://news.ycombinator.com/' }],
	})
})

test('anthropic OAuth user-agent discloses hal and its git version', async () => {
	let seenUserAgent = ''
	installFetchMock(async (_input, init) => {
		seenUserAgent = String((init!.headers as Record<string, string>)['user-agent'] ?? '')
		return new Response(anthropicSse(), { status: 200, headers: { 'content-type': 'text/event-stream' } }) as any
	})
	version.state.combined = 'abcd1234+ef567890'

	await collect({ value: 'tok-test', type: 'token' })
	expect(seenUserAgent).toBe('claude-cli/2.1.280 (external, hal/abcd1234+ef567890)')
})

test('anthropic OAuth user-agent omits the version until it is known', async () => {
	let seenUserAgent = ''
	installFetchMock(async (_input, init) => {
		seenUserAgent = String((init!.headers as Record<string, string>)['user-agent'] ?? '')
		return new Response(anthropicSse(), { status: 200, headers: { 'content-type': 'text/event-stream' } }) as any
	})
	version.state.combined = ''

	await collect({ value: 'tok-test', type: 'token' })
	expect(seenUserAgent).toBe('claude-cli/2.1.280 (external, hal)')
})
