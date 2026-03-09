import { describe, test, expect } from 'bun:test'
import { compactApiMessages } from './compact.ts'

// Helper: build an API-format tool cycle (assistant with tool_use + user with tool_result)
function toolCycle(id: string, name: string, input: any, result: string, ref: string) {
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
			content: [{ type: 'tool_result', tool_use_id: id, content: result, _ref: ref }],
		},
	}
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
		expect(oldResult.content).toBe('[cleared — ref: ref-0]')
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

	test('clears last batch too when >5 user turns follow', () => {
		const c0 = toolCycle('t0', 'bash', { command: 'ls' }, 'result', 'ref-0')

		const msgs: any[] = [
			{ role: 'user', content: 'start' },
			c0.assistant, c0.result,
		]
		// Add 6 user turns after the tool batch
		for (let i = 0; i < 6; i++) {
			msgs.push({ role: 'user', content: `question ${i}` })
			msgs.push({ role: 'assistant', content: [{ type: 'text', text: `answer ${i}` }] })
		}

		const out = compactApiMessages(msgs)

		// Even the "last" batch should be cleared since it's stale
		const toolResult = out[2].content[0]
		expect(toolResult.content).toBe('[cleared — ref: ref-0]')
	})

	test('keeps last batch when ≤5 user turns follow', () => {
		const c0 = toolCycle('t0', 'bash', { command: 'ls' }, 'result', 'ref-0')

		const msgs: any[] = [
			{ role: 'user', content: 'start' },
			c0.assistant, c0.result,
		]
		for (let i = 0; i < 5; i++) {
			msgs.push({ role: 'user', content: `question ${i}` })
			msgs.push({ role: 'assistant', content: [{ type: 'text', text: `answer ${i}` }] })
		}

		const out = compactApiMessages(msgs)

		// Should still be kept — exactly 5 is the boundary
		const toolResult = out[2].content[0]
		expect(toolResult.content).toBe('result')
	})

	test('clears images except in last 2 user turns', () => {
		const imageBlock = (ref: string) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' }, _ref: ref })

		const msgs = [
			{ role: 'user', content: [{ type: 'text', text: 'look at this' }, imageBlock('ref-img-0')] },
			{ role: 'assistant', content: [{ type: 'text', text: 'nice image' }] },
			{ role: 'user', content: [{ type: 'text', text: 'another' }, imageBlock('ref-img-1')] },
			{ role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
			{ role: 'user', content: [{ type: 'text', text: 'and this' }, imageBlock('ref-img-2')] },
			{ role: 'assistant', content: [{ type: 'text', text: 'got it' }] },
		]

		const out = compactApiMessages(msgs)

		// First image (3 user turns ago) should be cleared with ref
		expect(out[0].content[1]).toEqual({ type: 'text', text: '[image cleared — ref: ref-img-0]' })
		// Second image (2 user turns ago) should be kept
		expect(out[2].content[1].type).toBe('image')
		// Third image (1 user turn ago = last) should be kept
		expect(out[4].content[1].type).toBe('image')
	})

	test('clears image when followed by plain string user turns', () => {
		const imageBlock = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' }, _ref: 'ref-img-0' }

		const msgs = [
			{ role: 'user', content: [{ type: 'text', text: 'look at this' }, imageBlock] },
			{ role: 'assistant', content: [{ type: 'text', text: 'nice image' }] },
			{ role: 'user', content: 'hello' },
			{ role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
			{ role: 'user', content: 'stop' },
			{ role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
		]

		const out = compactApiMessages(msgs)

		// Image is 3 user turns ago (image, "hello", "stop") — should be cleared with ref
		expect(out[0].content[1]).toEqual({ type: 'text', text: '[image cleared — ref: ref-img-0]' })
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
					{ type: 'tool_result', tool_use_id: 't0', content: 'result a', _ref: 'ref-a' },
					{ type: 'tool_result', tool_use_id: 't1', content: 'result b', _ref: 'ref-b' },
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
					{ type: 'tool_result', tool_use_id: 't2', content: 'file contents', _ref: 'ref-c' },
				],
			},
		]

		const out = compactApiMessages(msgs)

		// Old batch (t0, t1) cleared
		expect(out[2].content[0].content).toBe('[cleared — ref: ref-a]')
		expect(out[2].content[1].content).toBe('[cleared — ref: ref-b]')

		// Last batch (t2) kept
		expect(out[5].content[0].content).toBe('file contents')
	})

	test('tool_result without _ref gets generic placeholder', () => {
		const msgs = [
			{ role: 'user', content: 'go' },
			{
				role: 'assistant',
				content: [{ type: 'tool_use', id: 't0', name: 'bash', input: { command: 'ls' } }],
			},
			{
				role: 'user',
				content: [{ type: 'tool_result', tool_use_id: 't0', content: 'old stuff' }],
			},
			{ role: 'user', content: 'next' },
			{
				role: 'assistant',
				content: [{ type: 'tool_use', id: 't1', name: 'bash', input: { command: 'pwd' } }],
			},
			{
				role: 'user',
				content: [{ type: 'tool_result', tool_use_id: 't1', content: '/home', _ref: 'ref-1' }],
			},
		]

		const out = compactApiMessages(msgs)
		expect(out[2].content[0].content).toBe('[cleared]')
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
		const msgs = [
			{ role: 'user', content: 'go' },
			{
				role: 'assistant',
				content: [{ type: 'tool_use', id: 't0', name: 'ask', input: { question: 'show me' } }],
			},
			{
				role: 'user',
				content: [{ type: 'tool_result', tool_use_id: 't0', content: [{ type: 'text', text: 'here' }, imageBlock], _ref: 'ref-0' }],
			},
			{ role: 'user', content: 'next' },
			{ role: 'user', content: 'more' },
			{ role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
		]

		const out = compactApiMessages(msgs)

		// tool_result is 3 user turns ago — image inside should be cleared
		const toolResult = out[2].content[0]
		expect(toolResult.content[0]).toEqual({ type: 'text', text: 'here' })
		expect(toolResult.content[1]).toEqual({ type: 'text', text: '[image cleared]' })
	})
})