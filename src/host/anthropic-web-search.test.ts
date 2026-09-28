import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { ason } from '../common/ason.ts'
import { blocks } from '../common/blocks.ts'
import { replay } from '../common/replay.ts'
import { settings } from '../common/settings.ts'
import { transcript } from '../common/transcript.ts'
import { anthropic } from './anthropic.ts'
import { auth } from './auth.ts'
import { openaiCompat } from './openai-compat.ts'
import { provider } from './provider.ts'

let home: string
let server: ReturnType<typeof Bun.serve>
let requests: any[] = []
let reply: () => Response
let original = anthropic.apiUrl
let previous = process.env.HAL_HOME
const results = [{ type: 'web_search_result', title: 'A page', url: 'https://example.org/a', encrypted_content: 'opaque' }]
const start = (index: number, content_block: unknown) => ({ type: 'content_block_start', index, content_block })
const stop = (index: number) => ({ type: 'content_block_stop', index })
const sse = (...events: any[]) => new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
const run = async (model = 'anthropic/claude-sonnet-4-5', messages: any[] = [{ role: 'user', blocks: [{ type: 'text', text: 'Find it' }] }]) => {
	let events = []
	for await (let event of provider.stream(model, { messages })) events.push(event)
	return events
}

beforeEach(() => {
	home = mkdtempSync(`${tmpdir()}/hal-search-`)
	process.env.HAL_HOME = home
	writeFileSync(`${home}/auth.ason`, ason.stringify({ anthropic: { apiKey: 'fake-key' } }))
	requests = []
	reply = () => sse({ type: 'message_start', message: { usage: {} } }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} }, { type: 'message_stop' })
	server = Bun.serve({ port: 0, async fetch(req) { requests.push(await req.json()); return reply() } })
	anthropic.apiUrl = () => `http://127.0.0.1:${server.port}/messages`
	anthropic.init()
})
afterEach(() => {
	server.stop(true)
	auth.close()
	provider.state.providers = {}
	settings.state.raw = {}
	anthropic.apiUrl = original
	if (previous === undefined) delete process.env.HAL_HOME
	else process.env.HAL_HOME = previous
	rmSync(home, { recursive: true, force: true })
})

test('Claude alone gets native search, including without local tools; config disables it at call time', async () => {
	await run()
	expect(requests[0].tools).toContainEqual({ type: 'web_search_20250305', name: 'web_search', max_uses: 5 })
	settings.state.raw = { webSearch: false }
	await run()
	expect(requests[1].tools).toBeUndefined()
	settings.state.raw = { webSearch: 'no' }
	await run()
	expect(requests[2].tools).toContainEqual(expect.objectContaining({ name: 'web_search' }))
	expect(settings.warnings()).toEqual([expect.stringContaining('webSearch')])
	await run('anthropic/other-model')
	expect(requests[3].tools).toBeUndefined()
})

test('server search streams as two ordered provider-specific blocks; history replays the pair and renders a tool row', async () => {
	reply = () => sse(
		{ type: 'message_start', message: { usage: { input_tokens: 2, output_tokens: 1 } } },
		start(0, { type: 'server_tool_use', id: 'search1', name: 'web_search', input: {} }),
		{ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"sunrise"}' } }, stop(0),
		start(1, { type: 'web_search_tool_result', tool_use_id: 'search1', content: results }), stop(1),
		{ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 12 } }, { type: 'message_stop' },
	)
	let turn = blocks.collect(await run(), 'anthropic')
	expect(turn.blocks).toEqual([
		{ type: 'web_search_use', id: 'search1', input: { query: 'sunrise' } },
		{ type: 'web_search_result', toolUseId: 'search1', content: results },
	])
	expect(turn.usage).toEqual({ input: 2, output: 12 })
	let now = new Date().toISOString()
	let records = [{ type: 'user' as const, blocks: [{ type: 'text' as const, text: 'Find it' }], ts: now }, ...turn.blocks.map((block) => ({ type: 'assistant' as const, block, ts: now }))]
	let messages = replay.toMessages(records)
	await run('anthropic/claude-sonnet-4-5', messages)
	let wire = requests[1].messages.at(-1).content
	expect(wire.map((b: any) => b.type)).toEqual(['server_tool_use', 'web_search_tool_result'])
	expect(wire[0].input.query).toBe('sunrise')
	expect(wire[1].content).toEqual(results)
	let rows = records.slice(1).flatMap((r, i) => transcript.recordItems({ ...r, n: i + 2 }, i))
	expect(rows.map((r) => r.type)).toEqual(['tool', 'tool-result'])
	expect(rows[0]).toMatchObject({ name: 'web_search', input: { query: 'sunrise' } })
	expect(rows[1]).toMatchObject({ output: expect.stringContaining('https://example.org/a') })
	let foreign = openaiCompat.toMessages({ model: 'other', messages })
	expect(foreign).toHaveLength(1)
	expect(foreign[0]).toMatchObject({ role: 'user', content: expect.stringContaining('Find it') })
})

test('a lone use or result is dropped, even if the matching block lies across a message boundary', async () => {
	let use = { type: 'web_search_use' as const, id: 's1', input: { query: 'one' } }
	let result = { type: 'web_search_result' as const, toolUseId: 's1', content: results }
	let messages = [{ role: 'assistant' as const, blocks: [use, { type: 'text' as const, text: 'still here' }] }, { role: 'user' as const, blocks: [{ type: 'text' as const, text: 'more' }] }, { role: 'assistant' as const, blocks: [result] }]
	await run('anthropic/claude-sonnet-4-5', messages)
	expect(requests[0].messages.map((m: any) => m.content.map((b: any) => b.type))).toEqual([['text'], ['text']])
	await run('anthropic/claude-sonnet-4-5', [{ role: 'assistant', blocks: [result, use] }])
	expect(requests[1].messages).toEqual([])
})
