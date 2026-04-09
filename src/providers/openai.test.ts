import { afterEach, expect, test } from 'bun:test'
import { auth, type Credential } from '../auth.ts'
import { createCompatProvider, openaiProvider } from './openai.ts'

interface FetchCall {
	url: string
	init?: RequestInit
}

const origFetch = globalThis.fetch
const origGetCredential = auth.getCredential
const origGetEntry = auth.getEntry
const origEnsureFresh = auth.ensureFresh
const origMarkCooldown = auth.markCooldown
const origHasAvailableCredential = auth.hasAvailableCredential

afterEach(() => {
	globalThis.fetch = origFetch
	auth.getCredential = origGetCredential
	auth.getEntry = origGetEntry
	auth.ensureFresh = origEnsureFresh
	auth.markCooldown = origMarkCooldown
	auth.hasAvailableCredential = origHasAvailableCredential
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
	expect(events).toContainEqual({ type: 'done', usage: { input: 3, output: 4 } })
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
	expect(events).toContainEqual({ type: 'done', usage: { input: 3, output: 4 } })
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
	expect(events).toContainEqual({ type: 'done', usage: { input: 5, output: 6 } })
})


test('openai 429 shows email and retries fast when another account is available', async () => {
	const credential: Credential = { value: 'sk-test', type: 'api-key', email: 'burned@test.com', _key: 'openai:0' }
	let cooldownMs = 0
	let cooldownCred: Credential | undefined
	auth.ensureFresh = async () => {}
	auth.getCredential = () => credential
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
	expect(events[0]).toMatchObject({
		type: 'error',
		message: 'openai 429: rate limited (burned@test.com)',
		status: 429,
		retryAfterMs: 1_000,
	})
	expect(events.at(-1)).toEqual({ type: 'done' })
})

test('openai 429 waits for reset when all accounts are on cooldown', async () => {
	const credential: Credential = { value: 'sk-test', type: 'api-key', email: 'burned@test.com', _key: 'openai:0' }
	let cooldownMs = 0
	auth.ensureFresh = async () => {}
	auth.getCredential = () => credential
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
	expect(events[0]).toMatchObject({
		type: 'error',
		message: 'openai 429: rate limited (burned@test.com)',
		status: 429,
		retryAfterMs: 2_064_000,
	})
})
