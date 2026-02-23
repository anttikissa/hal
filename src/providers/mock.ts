/**
 * Mock provider — streams canned responses with no network calls.
 * Useful for testing and development. Use with: /model mock
 */
import type { Provider, StreamEvent } from '../provider.ts'

const GREETING = [
	'Hello, I am a mock model. ',
	'To test my output, you can try various prompts:\n\n',
	'**song** — I will sing a song for you\n',
	'**read** [ filename ] — I will try to read a file and summarize it for you\n',
	'**write** filename contents — I will try to write a file\n',
	'**think** — I will demonstrate my thinking abilities\n',
]

/** Build a ReadableStream that emits Anthropic-format SSE for a text response */
function makeSSEStream(chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder()
	let index = 0

	return new ReadableStream({
		async pull(controller) {
			if (index === 0) {
				// message_start
				controller.enqueue(encoder.encode(
					'event: message_start\n' +
					`data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } })}\n\n`
				))
				// content_block_start
				controller.enqueue(encoder.encode(
					'event: content_block_start\n' +
					`data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text' } })}\n\n`
				))
			}

			if (index < chunks.length) {
				const text = chunks[index++]
				// Small delay to simulate streaming
				await new Promise(r => setTimeout(r, 30))
				controller.enqueue(encoder.encode(
					'event: content_block_delta\n' +
					`data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}\n\n`
				))
			} else {
				// content_block_stop + message_delta + message_stop
				controller.enqueue(encoder.encode(
					'event: content_block_stop\n' +
					`data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n` +
					'event: message_delta\n' +
					`data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: chunks.length * 5 } })}\n\n`
				))
				controller.close()
			}
		},
	})
}

function generateResponse(_messages: any[]): string[] {
	return GREETING
}

export const mockProvider: Provider = {
	name: 'mock',

	async refreshAuth() {},

	async fetch(body: any, _signal?: AbortSignal) {
		const chunks = generateResponse(body.messages ?? [])
		const stream = makeSSEStream(chunks)
		return new Response(stream, {
			status: 200,
			headers: { 'Content-Type': 'text/event-stream' },
		})
	},

	buildRequestBody({ model, messages, system, tools, maxTokens }) {
		return { model, messages, system, tools, max_tokens: maxTokens }
	},

	// Reuse Anthropic SSE format — parseSSE is identical
	parseSSE(rawEvent: { type: string; data: string }): StreamEvent[] {
		let event: any
		try {
			event = JSON.parse(rawEvent.data)
		} catch {
			return []
		}

		if (event.type === 'message_start') {
			if (event.message?.usage) return [{ type: 'usage', usage: event.message.usage }]
			return []
		}
		if (event.type === 'content_block_start') {
			const block = event.content_block
			if (block.type === 'text') return [{ type: 'text_start', index: event.index }]
			if (block.type === 'tool_use')
				return [{ type: 'tool_use_start', index: event.index, id: block.id, name: block.name }]
			return []
		}
		if (event.type === 'content_block_delta') {
			const delta = event.delta
			if (delta.type === 'text_delta')
				return [{ type: 'text_delta', index: event.index, text: delta.text }]
			if (delta.type === 'input_json_delta')
				return [{ type: 'tool_input_delta', index: event.index, json: delta.partial_json }]
			return []
		}
		if (event.type === 'content_block_stop') {
			return [{ type: 'block_stop', index: event.index }]
		}
		if (event.type === 'message_delta') {
			const events: StreamEvent[] = []
			if (event.delta?.stop_reason)
				events.push({ type: 'stop', stopReason: event.delta.stop_reason })
			if (event.usage) events.push({ type: 'usage', usage: event.usage })
			return events
		}
		return []
	},

	finalizeBlocks(blocks: any[]) {
		for (const block of blocks) {
			if (block?.type === 'tool_use' && typeof block.input === 'string') {
				try { block.input = JSON.parse(block.input) } catch { block.input = {} }
			}
		}
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

	async complete({ userMessage }) {
		return { text: `[mock] echo: ${userMessage.slice(0, 200)}` }
	},
}
