// Gemini's thoughtSignature must come back on its functionCall, or the
// next request is refused; foreign calls carry the skip value. The
// stream is recorded from OpenCode Go's Gemini route (task 83).

import { expect, test } from 'bun:test'
import { blocks, type StreamEvent } from '../common/blocks.ts'
import { gemini } from './gemini.ts'

const recorded = [
	'{"responseId":"E-XbarCGHceeuMYPhYT74Ao","modelVersion":"gemini-4-argon-contributor","candidates":[{"index":0,"content":{"role":"model","parts":[{"thoughtSignature":"ElkKVwFpFH0TyTy6","functionCall":{"id":"call_182465","name":"add","args":{"a":2,"b":3}}}]}}],"usageMetadata":{"candidatesTokenCount":16,"promptTokenCount":29,"totalTokenCount":45}}',
	'{"responseId":"E-XbarCGHceeuMYPhYT74Ao","modelVersion":"gemini-4-argon-contributor","candidates":[{"finishReason":"STOP","index":0,"content":{"role":"model","parts":[{"text":""}]}}],"usageMetadata":{"candidatesTokenCount":22,"promptTokenCount":90,"totalTokenCount":112}}',
]

test('a recorded tool call replays with its signature; a foreign call gets the skip value', async () => {
	let events: StreamEvent[] = []
	for await (let e of gemini.parse(
		(async function* () {
			for (let data of recorded) yield { event: undefined, data }
		})(),
	))
		events.push(e)
	let turn = blocks.collect(events, 'opencode-go')
	expect(turn.end).toEqual({ type: 'done', reason: 'tool_use' })
	expect(turn.usage).toEqual({ input: 90, output: 22 })

	let contents = gemini.contents({
		model: 'm',
		messages: [
			{ role: 'user', blocks: [{ type: 'text', text: 'add' }] },
			{ role: 'assistant', blocks: turn.blocks as any },
			{ role: 'user', blocks: [{ type: 'tool_result', id: 'call_182465', output: '5' }] },
			{ role: 'assistant', blocks: [{ type: 'tool_call', id: 'toolu_1', name: 'add', input: { a: 1, b: 1 } }] },
		],
	}) as any[]
	expect(contents[1].parts).toEqual([
		{ functionCall: { id: 'call_182465', name: 'add', args: { a: 2, b: 3 } }, thoughtSignature: 'ElkKVwFpFH0TyTy6' },
	])
	expect(contents[2].parts).toEqual([
		{ functionResponse: { id: 'call_182465', name: 'add', response: { output: '5' } } },
	])
	expect(contents[3].parts[0].thoughtSignature).toBe('skip_thought_signature_validator')
})
