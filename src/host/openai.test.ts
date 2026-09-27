// The OpenAI Responses provider through provider.stream: routing by
// credential, request mapping, stream events and failures. A fake server
// stands in for both OpenAI endpoints; fake JWTs and keys only.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { ason } from '../common/ason.ts'
import { blocks, type Message, type StreamEvent } from '../common/blocks.ts'
import { auth } from './auth.ts'
import { limits } from './limits.ts'
import { models } from './models.ts'
import { openai } from './openai.ts'
import { provider } from './provider.ts'

const saved = { HAL_HOME: process.env.HAL_HOME, OPENAI_API_KEY: process.env.OPENAI_API_KEY }
const orig = { apiUrl: openai.apiUrl, codexUrl: openai.codexUrl, tokenUrl: auth.tokenUrl }
let home = ''
let server: ReturnType<typeof Bun.serve>
let seen: { path: string; headers: Headers; body: any }[] = []
let reply: () => Response

const jwt = (claims: object) => `h.${btoa(JSON.stringify(claims)).replace(/=+$/, '')}.s`
const subscriptionToken = jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1' } })
const sse = (...events: object[]) => new Response(events.map((e) => `event: ${(e as any).type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
const completed = (usage?: object) => ({ type: 'response.completed', response: { status: 'completed', ...(usage && { usage }) } })
const writeAuth = (data: object) => writeFileSync(`${home}/auth.ason`, ason.stringify(data) + '\n', { mode: 0o600 })

beforeEach(() => {
	home = mkdtempSync(`${tmpdir()}/hal-openai-`)
	process.env.HAL_HOME = home
	mkdirSync(`${home}/state`)
	delete process.env.OPENAI_API_KEY
	seen = []
	reply = () => sse(completed())
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			let path = new URL(req.url).pathname
			if (path === '/token') return Response.json({ access_token: subscriptionToken, refresh_token: 'r2', expires_in: 3600 })
			seen.push({ path, headers: req.headers, body: await req.json() })
			return reply()
		},
	})
	openai.apiUrl = () => `http://127.0.0.1:${server.port}/v1/responses`
	openai.codexUrl = () => `http://127.0.0.1:${server.port}/codex/responses`
	auth.tokenUrl = () => `http://127.0.0.1:${server.port}/token`
	openai.init()
})

afterEach(() => {
	auth.close()
	limits.close()
	server.stop(true)
	Object.assign(openai, { apiUrl: orig.apiUrl, codexUrl: orig.codexUrl })
	auth.tokenUrl = orig.tokenUrl
	provider.state.providers = {}
	for (let [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k]
		else process.env[k] = v
	}
	rmSync(home, { recursive: true, force: true })
})

const hi: Message[] = [{ role: 'user', blocks: [{ type: 'text', text: 'hi' }] }]

async function run(messages = hi, extra = {}, model = 'openai/gpt-5.5') {
	let out: StreamEvent[] = []
	for await (let e of provider.stream(model, { messages, ...extra })) out.push(e)
	return out
}

test('a ChatGPT token goes to the Codex backend with its account id; an API key to api.openai.com', async () => {
	writeAuth({ openai: { accessToken: subscriptionToken, refreshToken: 'r', expires: Date.now() + 3_600_000 } })
	await run(hi, { system: 'be brief', sessionId: 'sess-1' })
	expect(seen[0]!.path).toBe('/codex/responses')
	expect(seen[0]!.headers.get('authorization')).toBe(`Bearer ${subscriptionToken}`)
	expect(seen[0]!.headers.get('chatgpt-account-id')).toBe('acct-1')
	expect(seen[0]!.body).toMatchObject({ model: 'gpt-5.5', store: false, stream: true, instructions: 'be brief', prompt_cache_key: 'sess-1' })
	expect(seen[0]!.body.max_output_tokens).toBeUndefined()

	rmSync(`${home}/auth.ason`)
	auth.close()
	process.env.OPENAI_API_KEY = 'sk-test'
	await run(hi, { maxTokens: 1000 })
	expect(seen[1]!.path).toBe('/v1/responses')
	expect(seen[1]!.headers.get('authorization')).toBe('Bearer sk-test')
	expect(seen[1]!.headers.get('chatgpt-account-id')).toBeNull()
	expect(seen[1]!.body.max_output_tokens).toBe(1000)
})

test('a token with the Responses scope goes to api.openai.com; one naming no account blocks on login', async () => {
	let scoped = jwt({ scp: ['openid', 'api.responses.write'] })
	writeAuth({ openai: { accessToken: scoped } })
	await run()
	expect(seen[0]!.path).toBe('/v1/responses')
	writeAuth({ openai: { accessToken: jwt({ sub: 'x' }) } })
	auth.close()
	let out = await run()
	expect(out.at(-1)).toMatchObject({ type: 'error', failure: 'auth' })
	expect(seen).toHaveLength(1)
})

test('history maps to Responses input, replaying only its own reasoning', async () => {
	process.env.OPENAI_API_KEY = 'sk-test'
	let messages: Message[] = [
		{ role: 'user', blocks: [{ type: 'text', text: 'look' }, { type: 'image', blob: 'b1', mediaType: 'image/png' }] },
		{
			role: 'assistant',
			blocks: [
				{ type: 'thinking', text: 'claude thought', signature: 'sig', provider: 'anthropic' },
				{ type: 'thinking', text: 'gpt thought', signature: JSON.stringify({ encrypted_content: 'enc' }), provider: 'openai' },
				{ type: 'text', text: 'running it' },
				{ type: 'tool_call', id: 'c1', name: 'bash', input: { command: 'ls' } },
			],
		},
		{ role: 'user', blocks: [{ type: 'tool_result', id: 'c1', output: 'boom', isError: true }] },
	]
	await run(messages, { image: (blob: string) => (blob === 'b1' ? 'AAAA' : undefined), tools: [{ name: 'bash', description: 'run', inputSchema: { type: 'object' } }] })
	let body = seen[0]!.body
	expect(body.input).toEqual([
		{ role: 'user', content: [{ type: 'input_text', text: 'look' }, { type: 'input_image', detail: 'auto', image_url: 'data:image/png;base64,AAAA' }] },
		{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'gpt thought' }], encrypted_content: 'enc' },
		{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'running it', annotations: [] }] },
		{ type: 'function_call', call_id: 'c1', name: 'bash', arguments: '{"command":"ls"}' },
		{ type: 'function_call_output', call_id: 'c1', output: 'Error: boom' },
	])
	expect(body.tools).toEqual([{ type: 'function', name: 'bash', description: 'run', parameters: { type: 'object' } }])
	expect(body.include).toEqual(['reasoning.encrypted_content'])
})

test('text, reasoning, tool calls and usage fold into a turn that ends in tool_use', async () => {
	process.env.OPENAI_API_KEY = 'sk-test'
	reply = () =>
		sse(
			{ type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning' } },
			{ type: 'response.reasoning_summary_part.added', output_index: 0, summary_index: 0 },
			{ type: 'response.reasoning_summary_text.delta', output_index: 0, delta: 'think' },
			{ type: 'response.reasoning_summary_part.added', output_index: 0, summary_index: 1 },
			{ type: 'response.reasoning_summary_text.delta', output_index: 0, delta: 'more' },
			{ type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', encrypted_content: 'enc-1' } },
			{ type: 'response.output_text.delta', output_index: 1, delta: 'Hel' },
			{ type: 'response.output_text.delta', output_index: 1, delta: 'lo' },
			{ type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', call_id: 'call-1', name: 'read' } },
			{ type: 'response.function_call_arguments.delta', output_index: 2, delta: '{"path":' },
			{ type: 'response.function_call_arguments.delta', output_index: 2, delta: '"a.ts"}' },
			{ type: 'response.output_item.done', output_index: 2, item: { type: 'function_call', call_id: 'call-1', name: 'read' } },
			completed({ input_tokens: 100, output_tokens: 7, input_tokens_details: { cached_tokens: 60 } }),
		)
	let turn = blocks.collect(await run(), 'openai')
	expect(turn.blocks).toEqual([
		{ type: 'thinking', text: 'think\n\nmore', signature: JSON.stringify({ encrypted_content: 'enc-1' }), provider: 'openai' },
		{ type: 'text', text: 'Hello' },
		{ type: 'tool_call', id: 'call-1', name: 'read', input: { path: 'a.ts' } },
	])
	expect(turn.usage).toEqual({ input: 40, output: 7, cacheRead: 60 })
	expect(turn.end).toEqual({ type: 'done', reason: 'tool_use' })
})

test('incomplete responses stop for their reason; a failed one is an error with the provider\'s words', async () => {
	process.env.OPENAI_API_KEY = 'sk-test'
	reply = () => sse({ type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } })
	expect((await run()).at(-1)).toEqual({ type: 'done', reason: 'max_tokens' })
	reply = () => sse({ type: 'response.failed', response: { status: 'failed', instructions: 'SYSTEM PROMPT', error: { code: 'server_error', message: 'try later' } } })
	let end = (await run()).at(-1) as any
	expect(end).toMatchObject({ type: 'error', message: 'try later', failure: 'temporary' })
	expect(end.body).not.toContain('SYSTEM PROMPT')
})

test('a 429 limits that account until resets_in_seconds and the next account takes over', async () => {
	let other = jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-2' } })
	writeAuth({ openai: [{ accessToken: subscriptionToken, email: 'a@x' }, { accessToken: other, email: 'b@x' }] })
	reply = () => Response.json({ error: { type: 'usage_limit_reached', message: 'limit reached', resets_in_seconds: 3600 } }, { status: 429 })
	let before = Date.now()
	let end = (await run()).at(-1) as any
	expect(end).toMatchObject({ type: 'error', failure: 'limited' })
	expect(end.message).toContain('limit reached')
	let until = limits.until(limits.key('openai/gpt-5.5', 'a@x'))
	expect(until).toBeGreaterThanOrEqual(before + 3_600_000 - 1000)
	reply = () => sse(completed())
	await run()
	expect(seen.at(-1)!.headers.get('chatgpt-account-id')).toBe('acct-2')
})

test('a 401 refreshes the token once and retries at once', async () => {
	let old = jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1' }, v: 1 })
	writeAuth({ openai: { accessToken: old, refreshToken: 'r', email: 'a@x', expires: Date.now() + 3_600_000 } })
	reply = () => Response.json({ error: { message: 'token expired', code: 'token_expired' } }, { status: 401 })
	let end = (await run()).at(-1) as any
	expect(end).toMatchObject({ type: 'error', failure: 'auth' })
	expect(end.retryAt).toBeLessThanOrEqual(Date.now())
	expect(seen.at(-1)!.headers.get('authorization')).toBe(`Bearer ${old}`)
	reply = () => sse(completed())
	await run()
	expect(seen.at(-1)!.headers.get('authorization')).toBe(`Bearer ${subscriptionToken}`)
})

test('the picker offers models.dev ids and the known GPT ids; a subscription caps input at 272k', () => {
	expect(models.known()).toEqual(expect.arrayContaining(openai.knownModels().map((m) => `openai/${m}`)))
	writeAuth({ openai: { accessToken: subscriptionToken } })
	expect(models.contextWindow('openai/gpt-5.5')).toBe(272_000)
	writeAuth({ openai: { apiKey: 'sk-file' } })
	auth.close()
	expect(models.contextWindow('openai/gpt-5.5') ?? 0).not.toBe(272_000)
})
