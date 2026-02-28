import { describe, expect, test } from 'bun:test'
import { OpenAICompletionsProvider } from './openai-completions.ts'

function provider() {
	return new OpenAICompletionsProvider({
		name: 'ollama',
		baseUrl: 'http://localhost:11434/v1',
	})
}

describe('openai-completions provider', () => {
	test('buildRequestBody maps system, stream, and max tokens', () => {
		const p = provider()
		const body = p.buildRequestBody({
			model: 'llama3.2',
			messages: [{ role: 'user', content: 'hello' }],
			system: [{ type: 'text', text: 'be concise' }],
			tools: [],
			maxTokens: 123,
		})

		expect(body.model).toBe('llama3.2')
		expect(body.stream).toBe(true)
		expect(body.max_tokens).toBe(123)
		expect(body.messages[0]).toEqual({ role: 'system', content: 'be concise' })
		expect(body.messages[1]).toEqual({ role: 'user', content: 'hello' })
	})

	test('parseSSE streams text and stop events', () => {
		const p = provider()
		const first = p.parseSSE({
			type: '',
			data: JSON.stringify({ id: 'resp_1', choices: [{ index: 0, delta: { content: 'Hi' } }] }),
		})
		expect(first).toEqual([
			{ type: 'text_start', index: 0 },
			{ type: 'text_delta', index: 0, text: 'Hi' },
		])

		const second = p.parseSSE({
			type: '',
			data: JSON.stringify({ id: 'resp_1', choices: [{ index: 0, delta: { content: ' there' } }] }),
		})
		expect(second).toEqual([{ type: 'text_delta', index: 0, text: ' there' }])

		const done = p.parseSSE({
			type: '',
			data: JSON.stringify({ id: 'resp_1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
		})
		expect(done).toEqual([
			{ type: 'block_stop', index: 0 },
			{ type: 'stop', stopReason: 'end_turn' },
		])
	})

	test('parseSSE streams tool call deltas', () => {
		const p = provider()
		const start = p.parseSSE({
			type: '',
			data: JSON.stringify({
				id: 'resp_2',
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [{ index: 0, id: 'call_1', function: { name: 'write', arguments: '' } }],
						},
					},
				],
			}),
		})
		expect(start).toEqual([{ type: 'tool_use_start', index: 0, id: 'call_1', name: 'write' }])

		const delta = p.parseSSE({
			type: '',
			data: JSON.stringify({
				id: 'resp_2',
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [{ index: 0, function: { arguments: '{"path":"a.txt"}' } }],
						},
					},
				],
			}),
		})
		expect(delta).toEqual([{ type: 'tool_input_delta', index: 0, json: '{"path":"a.txt"}' }])

		const stop = p.parseSSE({
			type: '',
			data: JSON.stringify({
				id: 'resp_2',
				choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
			}),
		})
		expect(stop).toEqual([
			{ type: 'block_stop', index: 0 },
			{ type: 'stop', stopReason: 'tool_use' },
		])
	})

	test('normalizeUsage maps prompt/completion tokens', () => {
		const p = provider()
		expect(p.normalizeUsage({ prompt_tokens: 11, completion_tokens: 7 })).toEqual({
			input: 11,
			output: 7,
			cacheCreate: 0,
			cacheRead: 0,
		})
	})
})
