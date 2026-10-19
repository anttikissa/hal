// The OpenAI provider over its WebSocket transport: incremental requests,
// HTTP fallback, replay pairing and rate-limit events.

import { expect, test } from 'bun:test'
import { blocks, type Message } from '../common/blocks.ts'
import { replayText } from '../common/replay-text.ts'
import { openaiWs } from './openai-ws.ts'
import { usage } from './usage.ts'
import { nativeTool } from './native-tool.ts'
import { fake, hi, run, subscriptionToken, useFakeOpenai, writeAuth } from './openai-fixture.test.ts'

useFakeOpenai()

test('over a WebSocket, a request that extends the last one sends only the new items; a refused socket falls back to HTTP', async () => {
	writeAuth({ openai: { accessToken: subscriptionToken, refreshToken: 'r', expires: Date.now() + 3_600_000 } })
	openaiWs.state.enabled = true
	fake.wsSeen = []
	let messages: Message[] = [{ role: 'user', blocks: [{ type: 'text', text: 'one' }] }]
	let text = async () =>
		(await run(messages, { system: 's', sessionId: 'ws-1' }))
			.filter((e) => e.type === 'text')
			.map((e: any) => e.text)
			.join('')
	expect(await text()).toBe('ok')
	messages.push(
		{ role: 'assistant', blocks: [{ type: 'text', text: 'ok' }] },
		{ role: 'user', blocks: [{ type: 'text', text: 'two' }] },
	)
	expect(await text()).toBe('ok')
	expect(fake.wsSeen.map((b) => [b.type, b.previous_response_id, b.input.length])).toEqual([
		['response.create', undefined, 1],
		['response.create', 'resp-1', 1],
	])
	expect(fake.wsSeen[1].input[0].content[0].text).toBe('two')
	// An edited earlier message breaks the chain: everything goes again.
	messages[0] = { role: 'user', blocks: [{ type: 'text', text: 'one, edited' }] }
	await text()
	expect([fake.wsSeen[2].previous_response_id, fake.wsSeen[2].input.length]).toEqual([undefined, 3])
	expect(fake.seen.filter((r) => r.path === '/codex/responses')).toEqual([])

	fake.wsSeen = null
	openaiWs.close('ws-1')
	expect(await text()).toBe('')
	expect(fake.seen.filter((r) => r.path === '/codex/responses')).toHaveLength(1)
	expect(openaiWs.state.httpUntil).toBeGreaterThan(Date.now())
})

test.each([false, true])('WebSocket replay pairs results with backend calls when expanded=%s', async (expanded) => {
	writeAuth({ openai: { accessToken: subscriptionToken } })
	openaiWs.state.enabled = true
	fake.wsSeen = []
	let recording = await Bun.file(`${import.meta.dir}/../fixtures/openai-compound.sse`).text()
	fake.wsOutput = recording
		.split('\n')
		.filter((line) => line.startsWith('data: '))
		.map((line) => JSON.parse(line.slice(6)))
	let messages: Message[] = [...hi]
	let turn = blocks.collect(await run(messages, { sessionId: 'ws-calls', tools: [nativeTool.def()] }), 'openai')
	let call = turn.blocks.find((b) => b.type === 'tool_call')!
	expect(call.type).toBe('tool_call')
	if (call.type !== 'tool_call') throw new Error('recording has no tool call')
	let calls = expanded ? nativeTool.expand(call).map(replayText.asNative) : [call]
	messages.push(
		{ role: 'assistant', blocks: calls },
		{
			role: 'user',
			blocks: calls.map((c) => ({
				type: 'tool_result',
				id: c.id,
				output: 'Transport probe only; command not executed.',
			})),
		},
	)
	fake.wsOutput = []
	await run(messages, { sessionId: 'ws-calls', tools: [nativeTool.def()] })
	let sent = fake.wsSeen[1]
	expect(sent.previous_response_id).toBe(expanded ? undefined : 'resp-1')
	let effective = [
		...(expanded ? [] : fake.wsSeen[0].input.concat([{ type: 'function_call', call_id: call.id }])),
		...sent.input,
	]
	let invoked = new Set(effective.filter((i: any) => i.type === 'function_call').map((i: any) => i.call_id))
	let results = effective.filter((i: any) => i.type === 'function_call_output')
	expect(results).toHaveLength(expanded ? 2 : 1)
	expect(results.every((r: any) => invoked.has(r.call_id))).toBe(true)
})

test("over a WebSocket, codex.rate_limits updates the account's shared usage windows; a metered limit does not", async () => {
	writeAuth({ openai: { accessToken: subscriptionToken, refreshToken: 'r', expires: Date.now() + 3_600_000 } })
	openaiWs.state.enabled = true
	fake.wsSeen = []
	let reset = Math.floor(Date.now() / 1000) + 3600
	let limits = (limit: object, used: number) => ({
		type: 'codex.rate_limits',
		...limit,
		rate_limits: {
			primary: { used_percent: used, window_minutes: 300, reset_at: reset },
			secondary: { used_percent: 40, window_minutes: 10080, reset_at: reset + 86400 },
		},
	})
	fake.wsBefore = [limits({}, 12), limits({ metered_limit_name: 'codex_other' }, 99)]
	await run(hi, { system: 's', sessionId: 'ws-q' })
	let [windows] = Object.values(usage.store().openai ?? {})
	expect(windows?.['5h']).toMatchObject({ used: 12, resets: new Date(reset * 1000).toISOString() })
	expect(windows?.['7d']?.used).toBe(40)
})
