import { describe, test, expect, beforeEach } from 'bun:test'
import { openaiProvider } from './openai.ts'

function parse(data: any, type?: string) {
	return openaiProvider.parseSSE({
		type: type ?? data.type ?? '',
		data: JSON.stringify(data),
	})
}

beforeEach(() => {
	// Reset stream parser state before each test.
	openaiProvider.buildRequestBody({
		model: 'gpt-5.3-codex',
		messages: [],
		system: [],
		tools: [],
		maxTokens: 512,
		sessionId: 's-test',
	})
})

describe('openai provider SSE parser', () => {
	test('emits activity for response.in_progress and output_item.in_progress', () => {
		const inProgress = parse({
			type: 'response.in_progress',
			message: 'Planning next steps',
		})
		expect(inProgress).toEqual([{ type: 'activity', text: 'Planning next steps' }])

		const outputItemInProgress = parse({
			type: 'response.output_item.in_progress',
			status_text: 'Preparing tool call',
		})
		expect(outputItemInProgress).toEqual([{ type: 'activity', text: 'Preparing tool call' }])
	})

	test('function call argument deltas map to tool_input_delta', () => {
		const added = parse({
			type: 'response.output_item.added',
			output_index: 0,
			item: { type: 'function_call', call_id: 'call_1', name: 'write' },
		})
		expect(added.some((e) => e.type === 'tool_use_start')).toBe(true)

		const delta = parse({
			type: 'response.function_call_arguments.delta',
			output_index: 0,
			delta: '{"path":"a.txt"}',
		})
		expect(delta).toEqual([{ type: 'tool_input_delta', index: 0, json: '{"path":"a.txt"}' }])
	})

	test('response.completed sets stop reason to tool_use when function calls exist', () => {
		const completed = parse({
			type: 'response.completed',
			response: {
				status: 'completed',
				output: [{ type: 'function_call', name: 'write' }],
				usage: {
					input_tokens: 10,
					output_tokens: 5,
					input_tokens_details: { cached_tokens: 2 },
				},
			},
		})

		expect(completed.some((e) => e.type === 'usage')).toBe(true)
		const stop = completed.find((e) => e.type === 'stop')
		expect(stop).toEqual({ type: 'stop', stopReason: 'tool_use' })
	})

	test('error payload parsing uses best available message path', () => {
		const responseNested = parse({
			type: 'error',
			response: { error: { message: 'backend failed' } },
		})
		expect(responseNested).toEqual([{ type: 'error', message: 'error: backend failed' }])

		const explicitNested = parse({
			type: 'error',
			code: 'bad_request',
			error: { message: 'invalid input payload' },
		})
		expect(explicitNested).toEqual([
			{ type: 'error', message: 'bad_request: invalid input payload' },
		])
	})
})
