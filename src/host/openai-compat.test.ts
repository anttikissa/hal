import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { Message, StreamEvent } from '../common/blocks.ts'
import { openaiCompat } from './openai-compat.ts'
import { provider } from './provider.ts'

// A local fake Chat Completions server: records each request and
// answers with the scripted response.
type Seen = { path: string; auth: string | null; body: any }
let seen: Seen[] = []
let reply: () => Response = () => new Response('')
let server: ReturnType<typeof Bun.serve>

function sse(...chunks: unknown[]): Response {
	let text = chunks.map((c) => `data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`).join('')
	return new Response(text, { headers: { 'content-type': 'text/event-stream' } })
}

const originalEndpoints = openaiCompat.endpoints
const originalKey = process.env.FAKE_COMPAT_KEY

beforeEach(() => {
	seen = []
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			let path = new URL(req.url).pathname
			if (req.method === 'GET') {
				seen.push({ path, auth: req.headers.get('authorization'), body: undefined })
				return path === '/v1/models' ? Response.json({ data: [{ id: 'vendor/a-1' }, { id: 'b-2' }] }) : new Response('', { status: 404 })
			}
			seen.push({ path, auth: req.headers.get('authorization'), body: await req.json() })
			return reply()
		},
	})
	openaiCompat.endpoints = () => ({
		fake: { baseUrl: `http://localhost:${server.port}/v1/`, keyEnv: 'FAKE_COMPAT_KEY' },
		local: { baseUrl: `http://localhost:${server.port}/v1` },
	})
	process.env.FAKE_COMPAT_KEY = 'sk-test'
	openaiCompat.init()
})

afterEach(() => {
	server.stop(true)
	openaiCompat.endpoints = originalEndpoints
	provider.state.providers = {}
	if (originalKey === undefined) delete process.env.FAKE_COMPAT_KEY
	else process.env.FAKE_COMPAT_KEY = originalKey
})

async function run(model: string, messages: Message[] = [{ role: 'user', blocks: [{ type: 'text', text: 'hi' }] }], extra = {}): Promise<StreamEvent[]> {
	let out: StreamEvent[] = []
	for await (let e of provider.stream(model, { messages, ...extra })) out.push(e)
	return out
}

const finish = (reason: string) => ({ choices: [{ index: 0, delta: {}, finish_reason: reason }] })

test('conversation maps to Chat Completions messages; key and base URL come from config', async () => {
	reply = () => sse({ choices: [{ delta: { content: 'ok' } }] }, finish('stop'), '[DONE]')
	let messages: Message[] = [
		{ role: 'user', blocks: [{ type: 'text', text: 'list files' }] },
		{
			role: 'assistant',
			blocks: [
				{ type: 'thinking', text: 'secret', signature: 'sig', provider: 'anthropic' },
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
	let events = await run('fake/vendor/model-1', messages, { system: 'Be brief.', tools, maxTokens: 100 })
	expect(events).toEqual([{ type: 'text', text: 'ok' }, { type: 'done', reason: 'end' }])

	expect(seen).toHaveLength(1)
	expect(seen[0]!.path).toBe('/v1/chat/completions')
	expect(seen[0]!.auth).toBe('Bearer sk-test')
	let body = seen[0]!.body
	expect(body).toMatchObject({ model: 'vendor/model-1', stream: true, stream_options: { include_usage: true }, max_tokens: 100 })
	expect(body.tools).toEqual([{ type: 'function', function: { name: 'ls', description: 'List', parameters: { type: 'object' } } }])
	expect(body.messages[0]).toEqual({ role: 'system', content: 'Be brief.' })
	expect(body.messages[1]).toEqual({ role: 'user', content: 'list files' })
	// Foreign thinking is not sent; tool call arguments go as JSON text.
	let assistant = body.messages[2]
	expect(assistant.role).toBe('assistant')
	expect(assistant.content).toBe('Sure.')
	expect(JSON.stringify(assistant)).not.toContain('secret')
	expect(assistant.tool_calls.map((c: any) => [c.id, c.type, c.function.name, JSON.parse(c.function.arguments)])).toEqual([
		['c1', 'function', 'ls', { path: '.' }],
		['c2', 'function', 'cat', { path: 'x' }],
	])
	// Tool results come right after the calls; the error flag survives as text.
	expect(body.messages[3]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'a.txt' })
	expect(body.messages[4].role).toBe('tool')
	expect(body.messages[4].tool_call_id).toBe('c2')
	expect(body.messages[4].content).toContain('no such file')
	expect(body.messages[4].content).not.toBe('no such file')
	expect(body.messages[5]).toEqual({ role: 'user', content: 'thanks' })
	expect(body.messages).toHaveLength(6)
})

test('the key is read at call time; a missing key is an error naming the variable, with no request', async () => {
	delete process.env.FAKE_COMPAT_KEY
	let events = await run('fake/m')
	expect(events).toEqual([expect.objectContaining({ type: 'error', message: expect.stringContaining('FAKE_COMPAT_KEY') })])
	expect(seen).toHaveLength(0)

	process.env.FAKE_COMPAT_KEY = 'sk-later'
	reply = () => sse(finish('stop'), '[DONE]')
	await run('fake/m')
	expect(seen[0]!.auth).toBe('Bearer sk-later')
})

test('an endpoint without a key variable (local server) sends no authorization', async () => {
	reply = () => sse(finish('stop'), '[DONE]')
	expect(await run('local/llama')).toEqual([{ type: 'done', reason: 'end' }])
	expect(seen[0]!.auth).toBeNull()
})

test('stream: text, reasoning, fragmented parallel tool calls and usage', async () => {
	reply = () =>
		sse(
			{ choices: [{ delta: { reasoning: 'hmm' } }] },
			{ choices: [{ delta: { reasoning_content: ' ok' } }] },
			{ choices: [{ delta: { content: 'Look' } }] },
			{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', type: 'function', function: { name: 'ls', arguments: '{"pa' } }] } }] },
			{ choices: [{ delta: { tool_calls: [{ index: 1, id: 'b', type: 'function', function: { name: 'cat', arguments: '' } }] } }] },
			{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"."}' } }] } }] },
			{ choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '{}' } }] } }] },
			finish('tool_calls'),
			{ choices: [], usage: { prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 60 } } },
			'[DONE]',
		)
	expect(await run('fake/m')).toEqual([
		{ type: 'thinking', text: 'hmm' },
		{ type: 'thinking', text: ' ok' },
		{ type: 'text', text: 'Look' },
		{ type: 'tool_call', id: 'a', name: 'ls', input: { path: '.' } },
		{ type: 'tool_call', id: 'b', name: 'cat', input: {} },
		{ type: 'usage', usage: { input: 40, output: 7, cacheRead: 60 } },
		{ type: 'done', reason: 'tool_use' },
	])
})

test('finish reasons map to neutral stop reasons; a server that omits [DONE] still finishes', async () => {
	for (let [wire, reason] of [
		['length', 'max_tokens'],
		['content_filter', 'refusal'],
		['stop', 'end'],
	]) {
		reply = () => sse(finish(wire!))
		expect(await run('fake/m')).toEqual([{ type: 'done', reason: reason as any }])
	}
})

test('a tool call cut off by the length limit is no call', async () => {
	reply = () => sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'ls', arguments: '{"pa' } }] } }] }, finish('length'), '[DONE]')
	expect(await run('fake/m')).toEqual([{ type: 'done', reason: 'max_tokens' }])
})

test('errors: HTTP status, error chunk, bad tool JSON, stream cut before finish', async () => {
	reply = () => new Response('{"error":{"message":"bad key"}}', { status: 401 })
	expect(await run('fake/m')).toEqual([expect.objectContaining({ type: 'error', status: 401, body: expect.stringContaining('bad key') })])

	reply = () => sse({ choices: [{ delta: { content: 'x' } }] }, { error: { message: 'upstream overloaded', code: 502 } })
	expect(await run('fake/m')).toEqual([{ type: 'text', text: 'x' }, expect.objectContaining({ type: 'error', message: expect.stringContaining('upstream overloaded') })])

	reply = () => sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'ls', arguments: '{"pa' } }] } }] }, finish('tool_calls'), '[DONE]')
	expect(await run('fake/m')).toEqual([expect.objectContaining({ type: 'error', message: expect.stringContaining('ls') })])

	reply = () => sse({ choices: [{ delta: { content: 'partial' } }] })
	let events = await run('fake/m')
	expect(events.map((e) => e.type)).toEqual(['text', 'error'])
})

test('models are listed from the endpoint, with its key; without the key there is no list', async () => {
	let signal = new AbortController().signal
	expect(await provider.state.providers.fake!.models!(signal)).toEqual(['vendor/a-1', 'b-2'])
	expect(seen.at(-1)).toMatchObject({ path: '/v1/models', auth: 'Bearer sk-test' })
	delete process.env.FAKE_COMPAT_KEY
	let count = seen.length
	await expect(provider.state.providers.fake!.models!(signal)).rejects.toThrow(/FAKE_COMPAT_KEY/)
	expect(seen.length).toBe(count)
	expect(await provider.state.providers.local!.models!(signal)).toEqual(['vendor/a-1', 'b-2'])
})
