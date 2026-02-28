import { describe, test, expect } from 'bun:test'
import { sanitizeMessages } from './agent-loop.ts'

describe('sanitizeMessages web_search pairing', () => {
	const provider = { name: 'anthropic' } as any

	test('drops orphaned server_tool_use web_search block', () => {
		const messages = [
			{
				role: 'assistant',
				content: [
					{
						type: 'server_tool_use',
						id: 'srvtoolu_1',
						name: 'web_search',
						input: { query: 'hello' },
						caller: { type: 'direct' },
					},
					{ type: 'text', text: 'After search.' },
				],
			},
		]

		const sanitized = sanitizeMessages(provider, messages)
		expect(sanitized).toEqual([
			{
				role: 'assistant',
				content: [{ type: 'text', text: 'After search.' }],
			},
		])
	})

	test('drops orphaned web_search_tool_result block', () => {
		const messages = [
			{
				role: 'assistant',
				content: [
					{
						type: 'web_search_tool_result',
						tool_use_id: 'srvtoolu_1',
						content: [{ type: 'web_search_result', title: 'A', url: 'https://example.com' }],
					},
					{ type: 'text', text: 'Result summary.' },
				],
			},
		]

		const sanitized = sanitizeMessages(provider, messages)
		expect(sanitized).toEqual([
			{
				role: 'assistant',
				content: [{ type: 'text', text: 'Result summary.' }],
			},
		])
	})

	test('keeps matched web_search server_tool_use and result blocks', () => {
		const messages = [
			{
				role: 'assistant',
				content: [
					{
						type: 'server_tool_use',
						id: 'srvtoolu_1',
						name: 'web_search',
						input: { query: 'hello' },
						caller: { type: 'direct' },
					},
					{
						type: 'web_search_tool_result',
						tool_use_id: 'srvtoolu_1',
						content: [{ type: 'web_search_result', title: 'A', url: 'https://example.com' }],
					},
					{ type: 'text', text: 'Result summary.' },
				],
			},
		]

		const sanitized = sanitizeMessages(provider, messages)
		expect(sanitized).toEqual(messages)
	})
})
