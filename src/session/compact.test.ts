import { describe, test, expect } from 'bun:test'
import { compactApiMessages } from './compact.ts'

// Helper: build an API-format tool cycle (assistant with tool_use + user with tool_result)
function toolCycle(id: string, name: string, input: any, result: string, blobId: string) {
	return {
		assistant: {
			role: 'assistant',
			content: [
				{ type: 'text', text: `calling ${name}` },
				{ type: 'tool_use', id, name, input },
			],
		},
		result: {
			role: 'user',
			content: [{ type: 'tool_result', tool_use_id: id, content: result, _blobId: blobId }],
		},
	}
}

// Helper: a user+assistant text exchange (one completed turn)
function turn(q: string, a: string) {
	return [
		{ role: 'user', content: q },
		{ role: 'assistant', content: [{ type: 'text', text: a }] },
	]
}

describe('compactApiMessages', () => {
	test('keeps last tool batch intact', () => {
		const c0 = toolCycle('t0', 'bash', { command: 'ls' }, 'file1.ts', 'ref-0')
		const c1 = toolCycle('t1', 'bash', { command: 'cat f' }, 'contents...', 'ref-1')

		const msgs = [
			{ role: 'user', content: 'list files' },
			c0.assistant, c0.result,
			{ role: 'user', content: 'show file' },
			c1.assistant, c1.result,
		]

		const out = compactApiMessages(msgs)

		// Last batch (c1) kept intact
		const lastResult = out[5].content[0]
		expect(lastResult.content).toBe('contents...')

		// Old batch (c0) cleared
		const oldResult = out[2].content[0]
		expect(oldResult.content).toBe('[tool result omitted from context — blob ref-0; use read_blob if needed]')
	})

	test('clears old tool_use inputs', () => {
		const c0 = toolCycle('t0', 'write', { path: 'f.ts', content: 'big file...' }, 'ok', 'ref-0')
		const c1 = toolCycle('t1', 'bash', { command: 'ls' }, 'file.ts', 'ref-1')

		const msgs = [
			{ role: 'user', content: 'write file' },
			c0.assistant, c0.result,
			{ role: 'user', content: 'check' },
			c1.assistant, c1.result,
		]

		const out = compactApiMessages(msgs)

		// Old tool_use input cleared
		const oldToolUse = out[1].content.find((b: any) => b.type === 'tool_use')
		expect(oldToolUse.input).toEqual({})

		// Last tool_use input kept
		const lastToolUse = out[4].content.find((b: any) => b.type === 'tool_use')
		expect(lastToolUse.input).toEqual({ command: 'ls' })
	})

	test('clears last batch too when >4 completed turns follow', () => {
		const c0 = toolCycle('t0', 'bash', { command: 'ls' }, 'result', 'ref-0')

		const msgs: any[] = [
			{ role: 'user', content: 'start' },
			c0.assistant, c0.result,
		]
		// Add 5 completed turns after the tool batch
		for (let i = 0; i < 5; i++) {
			msgs.push(...turn(`question ${i}`, `answer ${i}`))
		}

		const out = compactApiMessages(msgs)

		// Even the "last" batch should be cleared since it's stale (5 > 4)
		const toolResult = out[2].content[0]
		expect(toolResult.content).toBe('[tool result omitted from context — blob ref-0; use read_blob if needed]')
	})

	test('keeps last batch when ≤4 completed turns follow', () => {
		const c0 = toolCycle('t0', 'bash', { command: 'ls' }, 'result', 'ref-0')

		const msgs: any[] = [
			{ role: 'user', content: 'start' },
			c0.assistant, c0.result,
		]
		for (let i = 0; i < 4; i++) {
			msgs.push(...turn(`question ${i}`, `answer ${i}`))
		}

		const out = compactApiMessages(msgs)

		// Should still be kept — exactly 4 is the boundary
		const toolResult = out[2].content[0]
		expect(toolResult.content).toBe('result')
	})

	test('clears images except in last 4 completed turns', () => {
		const imageBlock = (ref: string) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' }, _blobId: ref })

		const msgs = [
			{ role: 'user', content: [{ type: 'text', text: 'look at this' }, imageBlock('ref-img-0')] },
			{ role: 'assistant', content: [{ type: 'text', text: 'nice image' }] },
			{ role: 'user', content: [{ type: 'text', text: 'another' }, imageBlock('ref-img-1')] },
			{ role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
			{ role: 'user', content: [{ type: 'text', text: 'and this' }, imageBlock('ref-img-2')] },
			{ role: 'assistant', content: [{ type: 'text', text: 'got it' }] },
			{ role: 'user', content: [{ type: 'text', text: 'more' }, imageBlock('ref-img-3')] },
			{ role: 'assistant', content: [{ type: 'text', text: 'yep' }] },
			{ role: 'user', content: [{ type: 'text', text: 'last one' }, imageBlock('ref-img-4')] },
			{ role: 'assistant', content: [{ type: 'text', text: 'done' }] },
		]

		const out = compactApiMessages(msgs)

		// First image (5 turns ago) should be cleared with a blob placeholder
		expect(out[0].content[1]).toEqual({ type: 'text', text: '[image omitted from context — blob ref-img-0; use read_blob if needed]' })
		// Second image (4 turns ago) should be kept
		expect(out[2].content[1].type).toBe('image')
		// Third image (3 turns ago) should be kept
		expect(out[4].content[1].type).toBe('image')
		// Fourth image (2 turns ago) should be kept
		expect(out[6].content[1].type).toBe('image')
		// Fifth image (1 turn ago = last) should be kept
		expect(out[8].content[1].type).toBe('image')
	})

	test('clears image when followed by completed turns', () => {
		const imageBlock = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' }, _blobId: 'ref-img-0' }

		const msgs: any[] = [
			{ role: 'user', content: [{ type: 'text', text: 'look at this' }, imageBlock] },
			{ role: 'assistant', content: [{ type: 'text', text: 'nice image' }] },
		]
		// 4 more completed turns — image is 5 turns ago total
		for (let i = 0; i < 4; i++) {
			msgs.push(...turn(`q${i}`, `a${i}`))
		}

		const out = compactApiMessages(msgs)

		// Image is 5 completed turns ago — should be cleared
		expect(out[0].content[1]).toEqual({ type: 'text', text: '[image omitted from context — blob ref-img-0; use read_blob if needed]' })
	})

	test('no tool calls → messages unchanged', () => {
		const msgs = [
			{ role: 'user', content: 'hello' },
			{ role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
			{ role: 'user', content: 'bye' },
		]

		const out = compactApiMessages(msgs)
		expect(out).toEqual(msgs)
	})

	test('handles multiple tool_results in one user message', () => {
		const msgs = [
			{ role: 'user', content: 'do stuff' },
			{
				role: 'assistant',
				content: [
					{ type: 'tool_use', id: 't0', name: 'bash', input: { command: 'a' } },
					{ type: 'tool_use', id: 't1', name: 'bash', input: { command: 'b' } },
				],
			},
			{
				role: 'user',
				content: [
					{ type: 'tool_result', tool_use_id: 't0', content: 'result a', _blobId: 'ref-a' },
					{ type: 'tool_result', tool_use_id: 't1', content: 'result b', _blobId: 'ref-b' },
				],
			},
			{ role: 'user', content: 'next' },
			{
				role: 'assistant',
				content: [
					{ type: 'tool_use', id: 't2', name: 'read', input: { path: 'f.ts' } },
				],
			},
			{
				role: 'user',
				content: [
					{ type: 'tool_result', tool_use_id: 't2', content: 'file contents', _blobId: 'ref-c' },
				],
			},
		]

		const out = compactApiMessages(msgs)

		// Old batch (t0, t1) cleared
		expect(out[2].content[0].content).toBe('[tool result omitted from context — blob ref-a; use read_blob if needed]')
		expect(out[2].content[1].content).toBe('[tool result omitted from context — blob ref-b; use read_blob if needed]')

		// Last batch (t2) kept
		expect(out[5].content[0].content).toBe('file contents')
	})

	test('preserves assistant text blocks in old messages', () => {
		const c0 = toolCycle('t0', 'bash', { command: 'ls' }, 'files', 'ref-0')
		const c1 = toolCycle('t1', 'bash', { command: 'pwd' }, '/home', 'ref-1')

		const msgs = [
			{ role: 'user', content: 'start' },
			c0.assistant, c0.result,
			{ role: 'user', content: 'next' },
			c1.assistant, c1.result,
		]

		const out = compactApiMessages(msgs)

		// Text blocks in old assistant message should be preserved
		const oldAssistant = out[1]
		const textBlock = oldAssistant.content.find((b: any) => b.type === 'text')
		expect(textBlock.text).toBe('calling bash')
	})

	test('clears images inside old tool_result content arrays', () => {
		const imageBlock = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
		const msgs: any[] = [
			{ role: 'user', content: 'go' },
			{
				role: 'assistant',
				content: [{ type: 'tool_use', id: 't0', name: 'ask', input: { question: 'show me' } }],
			},
			{
				role: 'user',
				content: [{ type: 'tool_result', tool_use_id: 't0', content: [{ type: 'text', text: 'here' }, imageBlock], _blobId: 'ref-0' }],
			},
		]
		// 5 completed turns to push the image past threshold
		for (let i = 0; i < 5; i++) {
			msgs.push(...turn(`q${i}`, `a${i}`))
		}

		const out = compactApiMessages(msgs)

		// tool_result is >4 turns ago — cleared entirely (not in keepIds)
		const toolResult = out[2].content[0]
		expect(toolResult.content).toBe('[tool result omitted from context — blob ref-0; use read_blob if needed]')
	})

	test('drops thinking blocks older than 10 completed turns', () => {
		const thinkingBlock = { type: 'thinking', thinking: 'deep thoughts...', signature: 'sig-abc' }

		const msgs: any[] = [
			{ role: 'user', content: 'start' },
			{ role: 'assistant', content: [thinkingBlock, { type: 'text', text: 'answer' }] },
		]
		// Add 11 completed turns to push the thinking block past threshold
		for (let i = 0; i < 11; i++) {
			msgs.push({ role: 'user', content: `q${i}` })
			msgs.push({ role: 'assistant', content: [
				{ type: 'thinking', thinking: `thought ${i}`, signature: `sig-${i}` },
				{ type: 'text', text: `a${i}` },
			] })
		}

		const out = compactApiMessages(msgs)

		// First assistant (12 completed turns ago) — thinking dropped, text kept
		expect(out[1].content).toEqual([{ type: 'text', text: 'answer' }])

		// Last assistant (0 turns ago) — thinking kept
		const last = out[out.length - 1]
		expect(last.content[0].type).toBe('thinking')
		expect(last.content[1].type).toBe('text')
	})

	test('keeps thinking blocks within 10 completed turns', () => {
		const thinkingBlock = { type: 'thinking', thinking: 'deep thoughts...', signature: 'sig-abc' }

		const msgs: any[] = [
			{ role: 'user', content: 'start' },
			{ role: 'assistant', content: [thinkingBlock, { type: 'text', text: 'answer' }] },
		]
		// Add 10 completed turns — exactly at the boundary
		for (let i = 0; i < 10; i++) {
			msgs.push(...turn(`q${i}`, `a${i}`))
		}

		const out = compactApiMessages(msgs)

		// First assistant (10 turns ago) — thinking should still be there
		expect(out[1].content[0].type).toBe('thinking')
	})

	test('custom heavyThreshold keeps tool results beyond default threshold', () => {
		const c0 = toolCycle('t0', 'bash', { command: 'ls' }, 'result', 'ref-0')

		const msgs: any[] = [
			{ role: 'user', content: 'start' },
			c0.assistant, c0.result,
		]
		// 6 completed turns — beyond default (4), within custom (10)
		for (let i = 0; i < 6; i++) {
			msgs.push(...turn(`question ${i}`, `answer ${i}`))
		}

		const out = compactApiMessages(msgs, { heavyThreshold: 10 })

		// With threshold 10, the tool result should still be kept
		const toolResult = out[2].content[0]
		expect(toolResult.content).toBe('result')
	})

	test('custom heavyThreshold keeps images beyond default threshold', () => {
		const imageBlock = (ref: string) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' }, _blobId: ref })

		const msgs: any[] = [
			{ role: 'user', content: [{ type: 'text', text: 'look' }, imageBlock('ref-img')] },
			{ role: 'assistant', content: [{ type: 'text', text: 'nice' }] },
		]
		// 6 more completed turns — image is 7 turns ago, beyond default 4 but within custom 10
		for (let i = 0; i < 6; i++) {
			msgs.push(...turn(`q${i}`, `a${i}`))
		}

		const out = compactApiMessages(msgs, { heavyThreshold: 10 })

		// Image should be kept with threshold 10
		expect(out[0].content[1].type).toBe('image')
	})

	test('tool_use without final response does not count as turn', () => {
		const c0 = toolCycle('t0', 'bash', { command: 'ls' }, 'old result', 'ref-0')

		// After the tool batch: many tool cycles but no final assistant text
		const msgs: any[] = [
			{ role: 'user', content: 'start' },
			c0.assistant, c0.result,
		]
		// Add 6 tool cycles (no turn ends — all assistants have tool_use)
		for (let i = 0; i < 6; i++) {
			const c = toolCycle(`t${i + 1}`, 'bash', { command: `cmd${i}` }, `res${i}`, `ref-${i + 1}`)
			msgs.push({ role: 'user', content: `next ${i}` }, c.assistant, c.result)
		}

		const out = compactApiMessages(msgs)

		// No completed turns → last tool batch is the LAST tool_use (t7), c0 is old
		// c0 is not in keepIds → cleared
		expect(out[2].content[0].content).toBe('[tool result omitted from context — blob ref-0; use read_blob if needed]')
	})
})
