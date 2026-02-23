/**
 * Test provider — returns canned responses, no network calls.
 * Registered under both 'anthropic' and 'openai' to intercept all models in --test mode.
 */
import type { Provider, StreamEvent, ToolDef } from '../provider.ts'

function makeTestProvider(name: string): Provider {
	return {
		name,
		async refreshAuth() {},
		async fetch(_body: any, _signal?: AbortSignal) {
			// Tests that don't send prompts never reach here.
			// Return a failed response so accidental calls are obvious.
			return new Response('test provider: no real API', { status: 500 })
		},
		buildRequestBody(params: {
			model: string
			messages: any[]
			system: any[]
			tools: ToolDef[]
			maxTokens: number
		}) {
			return params
		},
		parseSSE(_event: { type: string; data: string }): StreamEvent[] {
			return []
		},
		finalizeBlocks(blocks: any[]) {
			return blocks
		},
		addCacheBreakpoints(messages: any[]) {
			return messages
		},
		toolResultMessage(toolUseId: string, content: string) {
			return {
				role: 'user',
				content: [{ type: 'tool_result', tool_use_id: toolUseId, content }],
			}
		},
		normalizeUsage(usage: Record<string, number>) {
			return {
				input: usage.input_tokens ?? 0,
				output: usage.output_tokens ?? 0,
				cacheCreate: 0,
				cacheRead: 0,
			}
		},
		async complete(params: {
			model: string
			system: string
			userMessage: string
			maxTokens: number
		}) {
			return { text: `[test] echo: ${params.userMessage.slice(0, 200)}` }
		},
	}
}

export const testAnthropicProvider = makeTestProvider('anthropic')
export const testOpenaiProvider = makeTestProvider('openai')
