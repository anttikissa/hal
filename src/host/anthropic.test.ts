import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { ason } from '../common/ason.ts'
import { blocks, type Message, type StreamEvent } from '../common/blocks.ts'
import { anthropic } from './anthropic.ts'
import { auth } from './auth.ts'
import { provider } from './provider.ts'

// A local fake Messages server and fake credentials in a temp home:
// neither the real ./auth.ason nor the real API is ever touched.

type Seen = { path: string; query: string; headers: Headers; body: any }
let seen: Seen[] = []
let reply: () => Response = () => new Response('')
let models: () => Response = () => Response.json({ data: [{ id: 'claude-new-9' }, { id: 'claude-old-1' }] })
let server: ReturnType<typeof Bun.serve>
let home = ''
const savedHome = process.env.HAL_HOME
const originalUrl = anthropic.apiUrl
const originalTokenUrl = auth.tokenUrl

function sse(...events: any[]): Response {
	let text = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
	return new Response(text, { headers: { 'content-type': 'text/event-stream' } })
}

function writeAuth(entry: unknown) {
	writeFileSync(`${home}/auth.ason`, ason.stringify({ anthropic: entry }) + '\n', { mode: 0o600 })
}

beforeEach(() => {
	seen = []
	models = () => Response.json({ data: [{ id: 'claude-new-9' }, { id: 'claude-old-1' }] })
	home = mkdtempSync(`${tmpdir()}/hal-anthropic-`)
	process.env.HAL_HOME = home
	writeAuth({ accessToken: 'fake-oauth-token', refreshToken: 'r', expires: Date.now() + 3_600_000 })
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			let url = new URL(req.url)
			if (url.pathname === '/token') return Response.json({ access_token: 'refreshed-token', refresh_token: 'r2', expires_in: 3600 })
			if (req.method === 'GET') {
				seen.push({ path: url.pathname, query: url.search, headers: req.headers, body: undefined })
				return models()
			}
			seen.push({ path: url.pathname, query: url.search, headers: req.headers, body: await req.json() })
			return reply()
		},
	})
	anthropic.apiUrl = () => `http://127.0.0.1:${server.port}/v1/messages?beta=true`
	auth.tokenUrl = () => `http://127.0.0.1:${server.port}/token`
	anthropic.init()
})

afterEach(() => {
	auth.close()
	server.stop(true)
	anthropic.apiUrl = originalUrl
	auth.tokenUrl = originalTokenUrl
	provider.state.providers = {}
	if (savedHome === undefined) delete process.env.HAL_HOME
	else process.env.HAL_HOME = savedHome
	rmSync(home, { recursive: true, force: true })
})

async function run(messages: Message[] = [{ role: 'user', blocks: [{ type: 'text', text: 'hi' }] }], extra = {}, model = 'anthropic/claude-opus-4-5') {
	let out: StreamEvent[] = []
	for await (let e of provider.stream(model, { messages, ...extra })) out.push(e)
	return out
}

const start = (usage = {}) => ({ type: 'message_start', message: { usage } })
const stop = (reason: string, usage = {}) => [{ type: 'message_delta', delta: { stop_reason: reason }, usage }, { type: 'message_stop' }]
const endTurn = () => sse(start(), ...stop('end_turn'))

test('OAuth request: endpoint, headers and the required Claude Code system identity', async () => {
	reply = endTurn
	expect(await run(undefined, { system: 'Be brief.' })).toEqual([{ type: 'done', reason: 'end' }])
	let s = seen[0]!
	expect(s.path).toBe('/v1/messages')
	expect(s.query).toBe('?beta=true')
	expect(s.headers.get('authorization')).toBe('Bearer fake-oauth-token')
	expect(s.headers.get('x-api-key')).toBeNull()
	expect(s.headers.get('anthropic-version')).toBe('2023-06-01')
	expect(s.headers.get('anthropic-beta')!.split(',')).toEqual(expect.arrayContaining(['oauth-2025-04-20', 'claude-code-20250219']))
	expect(s.headers.get('user-agent')).toMatch(/^claude-cli\/\S+ \(external, hal/)
	expect(s.headers.get('x-app')).toBe('cli')
	// The identity must be the first system block, on its own.
	expect(s.body.system[0]).toEqual({ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." })
	expect(s.body.system.slice(1).map((b: any) => b.text.trim())).toEqual(['Be brief.'])
	// The model reads the blocks joined with no separator: they must
	// still read as separate paragraphs.
	expect(s.body.system.map((b: any) => b.text).join('')).toContain('for Claude.\n\nBe brief.')
	expect(s.body).toMatchObject({ model: 'claude-opus-4-5', stream: true })
	expect(s.body.max_tokens).toBeGreaterThan(0)
})

test('an API key credential uses x-api-key and no OAuth betas', async () => {
	writeAuth({ apiKey: 'fake-key' })
	reply = endTurn
	await run()
	let s = seen[0]!
	expect(s.headers.get('x-api-key')).toBe('fake-key')
	expect(s.headers.get('authorization')).toBeNull()
	expect(s.headers.get('anthropic-beta') ?? '').not.toContain('oauth')
})

test('missing credentials: an error naming the file, no request', async () => {
	rmSync(`${home}/auth.ason`)
	let events = await run()
	expect(events).toEqual([expect.objectContaining({ type: 'error', message: expect.stringContaining('auth.ason') })])
	expect(seen).toHaveLength(0)
})

test('conversation maps to Messages; own thinking replays with its signature, foreign does not', async () => {
	reply = endTurn
	let messages: Message[] = [
		{ role: 'user', blocks: [{ type: 'text', text: 'list files' }] },
		{
			role: 'assistant',
			blocks: [
				{ type: 'thinking', text: 'mine', signature: 'sig-1', provider: 'anthropic' },
				{ type: 'thinking', text: 'foreign secret', signature: '{"id":"rs_1"}', provider: 'openai' },
				{ type: 'thinking', text: 'unsigned' },
				{ type: 'text', text: 'Sure.' },
				{ type: 'tool_call', id: 'c1', name: 'ls', input: { path: '.' } },
				{ type: 'tool_call', id: 'c2', name: 'cat', input: { path: 'x' } },
			],
		},
		{
			role: 'user',
			blocks: [
				{ type: 'tool_result', id: 'c1', output: 'a.txt' },
				{ type: 'tool_result', id: 'c2', output: 'no such file', isError: true },
				{ type: 'text', text: 'thanks' },
			],
		},
	]
	let tools = [{ name: 'ls', description: 'List', inputSchema: { type: 'object' } }]
	await run(messages, { tools, maxTokens: 20_000 })
	let body = seen[0]!.body
	expect(body.max_tokens).toBe(20_000)
	expect(body.tools).toEqual([{ name: 'ls', description: 'List', input_schema: { type: 'object' } }])
	let strip = (m: any) => ({ role: m.role, content: m.content.map((b: any) => { let c = { ...b }; delete c.cache_control; return c }) })
	expect(body.messages.map(strip)).toEqual([
		{ role: 'user', content: [{ type: 'text', text: 'list files' }] },
		{
			role: 'assistant',
			content: [
				{ type: 'thinking', thinking: 'mine', signature: 'sig-1' },
				{ type: 'text', text: 'Sure.' },
				{ type: 'tool_use', id: 'c1', name: 'ls', input: { path: '.' } },
				{ type: 'tool_use', id: 'c2', name: 'cat', input: { path: 'x' } },
			],
		},
		{
			role: 'user',
			content: [
				{ type: 'tool_result', tool_use_id: 'c1', content: 'a.txt' },
				{ type: 'tool_result', tool_use_id: 'c2', content: 'no such file', is_error: true },
				{ type: 'text', text: 'thanks' },
			],
		},
	])
	// Prompt caching: the conversation prefix up to the last block is cached.
	expect(body.messages.at(-1).content.at(-1).cache_control).toEqual({ type: 'ephemeral' })
})

test('thinking is enabled within max_tokens, and skipped when there is no room for it', async () => {
	reply = endTurn
	await run(undefined, { maxTokens: 20_000 })
	let t = seen[0]!.body.thinking
	expect(t.type === 'adaptive' || (t.type === 'enabled' && t.budget_tokens >= 1024 && t.budget_tokens < 20_000)).toBe(true)

	await run(undefined, { maxTokens: 500 })
	expect(seen[1]!.body.thinking).toBeUndefined()
})

test('stream: thinking with signature, text, tool calls (with and without JSON deltas), usage', async () => {
	reply = () =>
		sse(
			start({ input_tokens: 10, cache_read_input_tokens: 500, cache_creation_input_tokens: 20, output_tokens: 1 }),
			{ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
			{ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let me ' } },
			{ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'see.' } },
			{ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG' } },
			{ type: 'content_block_stop', index: 0 },
			{ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
			{ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Looking' } },
			{ type: 'content_block_stop', index: 1 },
			{ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 't1', name: 'ls', input: {} } },
			{ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"pa' } },
			{ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: 'th":"."}' } },
			{ type: 'content_block_stop', index: 2 },
			{ type: 'content_block_start', index: 3, content_block: { type: 'tool_use', id: 't2', name: 'pwd', input: {} } },
			{ type: 'content_block_stop', index: 3 },
			...stop('tool_use', { output_tokens: 42 }),
		)
	let events = await run()
	let turn = blocks.collect(events, 'anthropic')
	expect(turn.blocks).toEqual([
		{ type: 'thinking', text: 'Let me see.', signature: 'SIG', provider: 'anthropic' },
		{ type: 'text', text: 'Looking' },
		{ type: 'tool_call', id: 't1', name: 'ls', input: { path: '.' } },
		{ type: 'tool_call', id: 't2', name: 'pwd', input: {} },
	])
	expect(turn.usage).toEqual({ input: 10, cacheRead: 500, cacheWrite: 20, output: 42 })
	expect(turn.end).toEqual({ type: 'done', reason: 'tool_use' })
	expect(events.at(-1)).toEqual({ type: 'done', reason: 'tool_use' })
})

test('redacted thinking survives a round trip', async () => {
	reply = () =>
		sse(
			start(),
			{ type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking', data: 'OPAQUE' } },
			{ type: 'content_block_stop', index: 0 },
			{ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
			{ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'ok' } },
			{ type: 'content_block_stop', index: 1 },
			...stop('end_turn'),
		)
	let turn = blocks.collect(await run(), 'anthropic')
	expect(turn.blocks[0]).toMatchObject({ type: 'thinking', text: '' })
	reply = endTurn
	await run([{ role: 'user', blocks: [{ type: 'text', text: 'hi' }] }, { role: 'assistant', blocks: turn.blocks }, { role: 'user', blocks: [{ type: 'text', text: 'again' }] }])
	expect(seen[1]!.body.messages[1].content).toEqual([
		{ type: 'redacted_thinking', data: 'OPAQUE' },
		{ type: 'text', text: 'ok' },
	])
})

test('stop reasons map to neutral ones', async () => {
	for (let [wire, reason] of [
		['end_turn', 'end'],
		['stop_sequence', 'end'],
		['max_tokens', 'max_tokens'],
		['refusal', 'refusal'],
	]) {
		reply = () => sse(start(), ...stop(wire!))
		expect(await run()).toEqual([{ type: 'done', reason: reason as any }])
	}
})

test('a tool call cut off by max_tokens is no call; a refusal keeps its explanation', async () => {
	let tool = (json: string) => [
		{ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't', name: 'ls', input: {} } },
		{ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: json } },
		{ type: 'content_block_stop', index: 0 },
	]
	reply = () => sse(start(), ...tool('{"pa'), ...stop('max_tokens'))
	expect(await run()).toEqual([{ type: 'done', reason: 'max_tokens' }])
	reply = () => sse(start(), { type: 'message_delta', delta: { stop_reason: 'refusal', stop_details: { explanation: 'No.' } }, usage: {} }, { type: 'message_stop' })
	expect(await run()).toEqual([{ type: 'done', reason: 'refusal', explanation: 'No.' }])
})

test('errors: HTTP status, error event mid-stream, bad tool JSON, stream cut short', async () => {
	reply = () => new Response('{"type":"error","error":{"type":"authentication_error","message":"bad token"}}', { status: 401 })
	expect(await run()).toEqual([expect.objectContaining({ type: 'error', status: 401, failure: 'auth', body: expect.stringContaining('bad token') })])
	// The rejected token is refreshed for the next request.
	reply = () => sse(start(), ...stop('end_turn'))
	expect(await run()).toEqual([{ type: 'done', reason: 'end' }])
	expect(seen.at(-1)!.headers.get('authorization')).toBe('Bearer refreshed-token')

	reply = () =>
		sse(
			start(),
			{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
			{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } },
			{ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
		)
	expect(await run()).toEqual([{ type: 'text', text: 'x' }, expect.objectContaining({ type: 'error', message: expect.stringContaining('Overloaded'), status: 529 })])

	reply = () =>
		sse(
			start(),
			{ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't', name: 'ls', input: {} } },
			{ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"pa' } },
			{ type: 'content_block_stop', index: 0 },
			...stop('tool_use'),
		)
	expect(await run()).toEqual([expect.objectContaining({ type: 'error', message: expect.stringContaining('ls') })])

	reply = () => sse(start(), { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
	expect((await run()).map((e) => e.type)).toEqual(['error'])
})

test('models are listed with the same credentials; a failed listing falls back to the known models', async () => {
	let signal = new AbortController().signal
	expect(await provider.state.providers.anthropic!.models!(signal)).toEqual(['claude-new-9', 'claude-old-1'])
	expect(seen.at(-1)!.path).toBe('/v1/models')
	expect(seen.at(-1)!.headers.get('authorization')).toBe('Bearer fake-oauth-token')
	models = () => new Response('nope', { status: 403 })
	expect(await provider.state.providers.anthropic!.models!(signal)).toEqual(anthropic.knownModels())
})
