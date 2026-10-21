// The OpenAI Responses provider through provider.stream: routing by
// credential, request mapping, stream events and failures. A fake server
// stands in for both OpenAI endpoints (openai-fixture.test.ts).

import { expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { blocks, type Message } from '../common/blocks.ts'
import { auth } from './auth.ts'
import { limits } from './limits.ts'
import { models } from './models.ts'
import { openai } from './openai.ts'
import { tools } from './tools.ts'
import { nativeTool } from './native-tool.ts'
import {
	completed,
	fake,
	hi,
	jwt,
	run,
	sse,
	subscriptionToken,
	useFakeOpenai,
	writeAuth,
} from './openai-fixture.test.ts'

useFakeOpenai()

test('a ChatGPT token goes to the Codex backend with its account id; an API key to api.openai.com', async () => {
	writeAuth({ openai: { accessToken: subscriptionToken, refreshToken: 'r', expires: Date.now() + 3_600_000 } })
	await run(hi, { system: 'be brief', sessionId: 'sess-1' })
	expect(fake.seen[0]!.path).toBe('/codex/responses')
	expect(fake.seen[0]!.headers.get('authorization')).toBe(`Bearer ${subscriptionToken}`)
	expect(fake.seen[0]!.headers.get('chatgpt-account-id')).toBe('acct-1')
	expect(fake.seen[0]!.headers.get('session_id')).toBe('sess-1')
	expect(fake.seen[0]!.headers.get('content-encoding')).toBe('zstd')
	expect(fake.seen[0]!.body).toMatchObject({
		model: 'gpt-5.5',
		store: false,
		stream: true,
		instructions: 'be brief',
		prompt_cache_key: 'sess-1',
		text: { verbosity: 'low' },
	})
	expect(fake.seen[0]!.body.max_output_tokens).toBeUndefined()

	rmSync(`${fake.home}/secrets/auth.ason`)
	auth.close()
	process.env.OPENAI_API_KEY = 'sk-test'
	await run(hi, { maxTokens: 1000 })
	expect(fake.seen[1]!.path).toBe('/v1/responses')
	expect(fake.seen[1]!.headers.get('authorization')).toBe('Bearer sk-test')
	expect(fake.seen[1]!.headers.get('chatgpt-account-id')).toBeNull()
	expect(fake.seen[1]!.headers.get('session_id')).toBeNull()
	expect(fake.seen[1]!.headers.get('content-encoding')).toBeNull()
	expect(fake.seen[1]!.body.max_output_tokens).toBe(1000)
})

test('fork cache routing uses inherited identity while credentials use the actual session', async () => {
	writeAuth({ openai: { accessToken: subscriptionToken } })
	await run(hi, { sessionId: 'actual-child', cacheId: 'original-family' })
	expect(fake.seen[0]!.headers.get('session_id')).toBe('original-family')
	expect(fake.seen[0]!.body.prompt_cache_key).toBe('original-family')
})

test('a token with the Responses scope goes to api.openai.com; one naming no account blocks on login', async () => {
	let scoped = jwt({ scp: ['openid', 'api.responses.write'] })
	writeAuth({ openai: { accessToken: scoped } })
	await run()
	expect(fake.seen[0]!.path).toBe('/v1/responses')
	writeAuth({ openai: { accessToken: jwt({ sub: 'x' }) } })
	auth.close()
	let out = await run()
	expect(out.at(-1)).toMatchObject({ type: 'error', failure: 'auth' })
	expect(fake.seen).toHaveLength(1)
})

test('history maps to Responses input, replaying only its own reasoning', async () => {
	process.env.OPENAI_API_KEY = 'sk-test'
	let messages: Message[] = [
		{
			role: 'user',
			blocks: [
				{ type: 'text', text: 'look' },
				{ type: 'image', blob: 'b1', mediaType: 'image/png' },
			],
		},
		{
			role: 'assistant',
			blocks: [
				{ type: 'thinking', text: 'claude thought', signature: 'sig', provider: 'anthropic' },
				{
					type: 'thinking',
					text: 'gpt thought',
					signature: JSON.stringify({ encrypted_content: 'enc' }),
					provider: 'openai',
				},
				{ type: 'text', text: 'running it' },
				{ type: 'tool_call', id: 'c1', name: 'bash', input: { command: 'ls' } },
			],
		},
		{ role: 'user', blocks: [{ type: 'tool_result', id: 'c1', output: 'boom', isError: true }] },
	]
	await run(messages, {
		image: (blob: string) => (blob === 'b1' ? 'AAAA' : undefined),
		tools: [{ name: 'bash', description: 'run', inputSchema: { type: 'object' } }],
	})
	let body = fake.seen[0]!.body
	expect(body.input).toEqual([
		{
			role: 'user',
			content: [
				{ type: 'input_text', text: 'look' },
				{ type: 'input_image', detail: 'auto', image_url: 'data:image/png;base64,AAAA' },
			],
		},
		{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'gpt thought' }], encrypted_content: 'enc' },
		{
			type: 'message',
			role: 'assistant',
			status: 'completed',
			content: [{ type: 'output_text', text: 'running it', annotations: [] }],
		},
		{ type: 'function_call', call_id: 'c1', name: 'bash', arguments: '{"command":"ls"}' },
		{ type: 'function_call_output', call_id: 'c1', output: 'Error: boom' },
	])
	expect(body.tools).toEqual([{ type: 'function', name: 'bash', description: 'run', parameters: { type: 'object' } }])
	expect(body.include).toEqual(['reasoning.encrypted_content'])
})

test('native search requires an allowlisted model, Hal tools, and absent or disabled Serper', () => {
	let req = { model: 'gpt-6.1-sol', messages: hi, tools: [nativeTool.def()] }
	for (let codex of [false, true]) expect(openai.body(req, codex).tools).toContainEqual({ type: 'web_search' })
	expect(openai.body({ ...req, tools: [] }, true).tools).toBeUndefined()
	expect(openai.body({ ...req, model: 'gpt-4o-mini' }, true).tools).not.toContainEqual({ type: 'web_search' })
	writeAuth({ serper: { apiKey: 'serper-test' } })
	expect(openai.body(req, true).tools).not.toContainEqual({ type: 'web_search' })
	let all = tools.all
	try {
		tools.all = () => all().filter((t) => t.name !== 'google')
		expect(openai.body(req, true).tools).toContainEqual({ type: 'web_search' })
	} finally {
		tools.all = all
	}
	process.env.SERPER_API_KEY = 'env-serper-test'
	rmSync(`${fake.home}/secrets/auth.ason`)
	auth.close()
	expect(openai.body(req, false).tools).not.toContainEqual({ type: 'web_search' })
})

test('recorded native search becomes readable history without a local tool round or duplicate citations', async () => {
	process.env.OPENAI_API_KEY = 'sk-test'
	let recording = await Bun.file(`${import.meta.dir}/../fixtures/openai-search.sse`).text()
	fake.reply = () => new Response(recording, { headers: { 'content-type': 'text/event-stream' } })
	let turn = blocks.collect(await run(), 'openai')
	expect(turn.end).toEqual({ type: 'done', reason: 'end' })
	let [search, answer] = turn.blocks
	expect(search).toEqual({
		type: 'hosted_tool',
		id: 'ws_058c1f3ca83fd353016acf3141fb4087d2917c750504b6797f',
		name: 'web_search',
		input: { query: 'VALO Hotel Helsinki official website' },
		output: '',
	})
	if (answer?.type !== 'text') throw new Error('expected answer text')
	let text = answer.text
	expect(text).toStartWith('Official website: https://valo.fi/en/')
	expect(text.match(/https:\/\/valo\.fi\/en\/\?utm_source=openai/g)).toHaveLength(1)
	expect(openai.input({ model: 'gpt-6.1-sol', messages: [{ role: 'assistant', blocks: [answer] }] })).toContainEqual({
		type: 'message',
		role: 'assistant',
		status: 'completed',
		content: [{ type: 'output_text', text, annotations: [] }],
	})
})

test('text, reasoning, tool calls and usage fold into a turn that ends in tool_use', async () => {
	process.env.OPENAI_API_KEY = 'sk-test'
	fake.reply = () =>
		sse(
			{ type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning' } },
			{ type: 'response.reasoning_summary_part.added', output_index: 0, summary_index: 0 },
			{ type: 'response.reasoning_summary_text.delta', output_index: 0, delta: 'think' },
			{ type: 'response.reasoning_summary_part.added', output_index: 0, summary_index: 1 },
			{ type: 'response.reasoning_summary_text.delta', output_index: 0, delta: 'more' },
			{ type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', encrypted_content: 'enc-1' } },
			{ type: 'response.output_text.delta', output_index: 1, delta: 'Hel' },
			{ type: 'response.output_text.delta', output_index: 1, delta: 'lo' },
			{
				type: 'response.output_item.added',
				output_index: 2,
				item: { type: 'function_call', call_id: 'call-1', name: 'read' },
			},
			{ type: 'response.function_call_arguments.delta', output_index: 2, delta: '{"path":' },
			{ type: 'response.function_call_arguments.delta', output_index: 2, delta: '"a.ts"}' },
			{
				type: 'response.output_item.done',
				output_index: 2,
				item: { type: 'function_call', call_id: 'call-1', name: 'read' },
			},
			completed({ input_tokens: 100, output_tokens: 7, input_tokens_details: { cached_tokens: 60 } }),
		)
	let turn = blocks.collect(await run(), 'openai')
	expect(turn.blocks).toEqual([
		{
			type: 'thinking',
			text: 'think\n\nmore',
			signature: JSON.stringify({ encrypted_content: 'enc-1' }),
			provider: 'openai',
		},
		{ type: 'text', text: 'Hello' },
		{ type: 'tool_call', id: 'call-1', name: 'read', input: { path: 'a.ts' } },
	])
	expect(turn.usage).toEqual({ input: 40, output: 7, cacheRead: 60 })
	expect(turn.end).toEqual({ type: 'done', reason: 'tool_use' })
})

test("incomplete responses stop for their reason; a failed one is an error with the provider's words", async () => {
	process.env.OPENAI_API_KEY = 'sk-test'
	fake.reply = () =>
		sse({
			type: 'response.incomplete',
			response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
		})
	expect((await run()).at(-1)).toEqual({ type: 'done', reason: 'max_tokens' })
	fake.reply = () =>
		sse({
			type: 'response.failed',
			response: {
				status: 'failed',
				instructions: 'SYSTEM PROMPT',
				error: { code: 'server_error', message: 'try later' },
			},
		})
	let end = (await run()).at(-1) as any
	expect(end).toMatchObject({ type: 'error', message: 'try later', failure: 'temporary' })
	expect(end.body).not.toContain('SYSTEM PROMPT')
})

test('a 429 limits that account until resets_in_seconds and the next account takes over', async () => {
	let other = jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-2' } })
	writeAuth({
		openai: [
			{ accessToken: subscriptionToken, email: 'a@x' },
			{ accessToken: other, email: 'b@x' },
		],
	})
	fake.reply = () =>
		Response.json(
			{ error: { type: 'usage_limit_reached', message: 'limit reached', resets_in_seconds: 3600 } },
			{ status: 429 },
		)
	let before = Date.now()
	let end = (await run()).at(-1) as any
	expect(end).toMatchObject({ type: 'error', failure: 'limited' })
	expect(end.message).toContain('limit reached')
	let until = limits.on('openai/gpt-6-luna', 'a@x')
	expect(until).toBeGreaterThanOrEqual(before + 3_600_000 - 1000)
	fake.reply = () => sse(completed())
	await run()
	expect(fake.seen.at(-1)!.headers.get('chatgpt-account-id')).toBe('acct-2')
})

test('a 401 refreshes the token once and retries at once', async () => {
	let old = jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1' }, v: 1 })
	writeAuth({ openai: { accessToken: old, refreshToken: 'r', email: 'a@x', expires: Date.now() + 3_600_000 } })
	fake.reply = () => Response.json({ error: { message: 'token expired', code: 'token_expired' } }, { status: 401 })
	let end = (await run()).at(-1) as any
	expect(end).toMatchObject({ type: 'error', failure: 'auth' })
	expect(end.retryAt).toBeLessThanOrEqual(Date.now())
	expect(fake.seen.at(-1)!.headers.get('authorization')).toBe(`Bearer ${old}`)
	fake.reply = () => sse(completed())
	await run()
	expect(fake.seen.at(-1)!.headers.get('authorization')).toBe(`Bearer ${subscriptionToken}`)
})

test('a ChatGPT login lists only the models the Codex backend shows it', async () => {
	writeAuth({ openai: { accessToken: subscriptionToken } })
	expect(await openai.listModels(new AbortController().signal)).toEqual(['gpt-6-sol'])
	expect(fake.seen[0]!.headers.get('chatgpt-account-id')).toBe('acct-1')
	writeAuth({ openai: { apiKey: 'sk-file' } })
	auth.close()
	expect(await openai.listModels(new AbortController().signal)).toEqual(expect.arrayContaining(openai.knownModels))
})

test('the picker offers models.dev ids and the known GPT ids; a subscription caps input at 272k', () => {
	expect(models.known()).toEqual(expect.arrayContaining(openai.knownModels.map((m) => `openai/${m}`)))
	writeAuth({ openai: { accessToken: subscriptionToken } })
	expect(models.contextWindow('openai/gpt-5.5')).toBe(272_000)
	writeAuth({ openai: { apiKey: 'sk-file' } })
	auth.close()
	expect(models.contextWindow('openai/gpt-5.5') ?? 0).not.toBe(272_000)
})

test('model discovery unions account catalogs rather than the request account and survives one failure', async () => {
	let other = jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-2' } })
	writeAuth({ openai: [{ accessToken: subscriptionToken }, { accessToken: other }, { apiKey: 'sk-test' }] })
	fake.catalogReply = (req) =>
		Response.json({
			models: (req.headers.get('chatgpt-account-id') === 'acct-1'
				? ['gpt-6-luna']
				: ['gpt-6-luna', 'gpt-6-astra', 'gpt-6.1-sol']
			).map((slug) => ({ slug, visibility: 'list' })),
		})
	expect(await openai.listModels(new AbortController().signal)).toEqual(['gpt-6-luna', 'gpt-6-astra', 'gpt-6.1-sol'])
	let key = openai.modelsKey()
	fake.catalogReply = (req) =>
		req.headers.get('chatgpt-account-id') === 'acct-1'
			? new Response(null, { status: 401 })
			: Response.json({ models: [{ slug: 'gpt-6-astra', visibility: 'list' }] })
	expect(await openai.listModels(new AbortController().signal)).toEqual(['gpt-6-astra'])
	auth.close()
	writeAuth({ openai: { accessToken: other } })
	expect(openai.modelsKey()).not.toBe(key)
	fake.catalogReply = () => new Response(null, { status: 401 })
	await expect(openai.listModels(new AbortController().signal)).rejects.toThrow('No OpenAI model catalog available')
})
