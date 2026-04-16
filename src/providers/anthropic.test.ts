import { afterEach, expect, test } from 'bun:test'
import { auth, type Credential } from '../auth.ts'
import { anthropicProvider } from './anthropic.ts'

const origFetch = globalThis.fetch
const origGetCredential = auth.getCredential
const origEnsureFresh = auth.ensureFresh
const origMarkCooldown = auth.markCooldown
const origHasAvailableCredential = auth.hasAvailableCredential

afterEach(() => {
	globalThis.fetch = origFetch
	auth.getCredential = origGetCredential
	auth.ensureFresh = origEnsureFresh
	auth.markCooldown = origMarkCooldown
	auth.hasAvailableCredential = origHasAvailableCredential
})

function installFetchMock(fn: (input: any, init?: RequestInit) => Promise<Response>): void {
	globalThis.fetch = Object.assign(fn, { preconnect: () => {} }) as typeof fetch
}

function anthropicSse(): string {
	return [
		'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}',
		'data: {"type":"message_delta","usage":{"output_tokens":4}}',
		'',
	].join('\n')
}

async function collect(credential: Credential): Promise<any[]> {
	auth.ensureFresh = async () => {}
	auth.getCredential = () => credential

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
	return events
}

test('anthropic provider reports the active account while rotating', async () => {
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

	expect(events[0]).toEqual({
		type: 'status',
		activity: 'Anthropic 1/3 · first@test.com',
	})
	expect(events).toContainEqual({ type: 'text', text: 'hello' })
	expect(events.at(-1)).toEqual({ type: 'done', usage: { input: 0, output: 4, cacheRead: 0, cacheCreation: 0 } })
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
	expect(events[0]).toEqual({ type: 'status', activity: 'Anthropic 1/3 · burned@test.com' })
	expect(events[1]).toMatchObject({
		type: 'error',
		message: 'Anthropic rotation: 3 accounts. 429 on burned@test.com. Trying next@test.com next.',
		status: 429,
		retryAfterMs: 1_000,
	})
	expect(events.at(-1)).toEqual({ type: 'done' })
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
	expect(events[0]).toEqual({ type: 'status', activity: 'Anthropic 1/3 · burned@test.com' })
	expect(events[1]).toMatchObject({
		type: 'error',
		message: 'Anthropic rotation: 3 accounts. 429 on burned@test.com. All accounts cooling down. Next: next@test.com in 42s.',
		status: 429,
		retryAfterMs: 42_000,
	})
})


test('anthropic provider ignores malformed SSE JSON lines', async () => {
	installFetchMock(async () => new Response([
		'data: {not json}',
		'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}',
		'data: {"type":"message_delta","usage":{"output_tokens":4}}',
		'',
	].join('\n'), {
		status: 200,
		headers: { 'content-type': 'text/event-stream' },
	}) as any)

	const events = await collect({ value: 'tok-test', type: 'token' })
	expect(events).toContainEqual({ type: 'text', text: 'hello' })
	expect(events.at(-1)).toEqual({ type: 'done', usage: { input: 0, output: 4, cacheRead: 0, cacheCreation: 0 } })
})
