/**
 * Mock provider — streams canned responses with no network calls.
 * Useful for testing and development. Use with: /model mock
 */
import { Provider } from '../provider.ts'

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
				await new Promise(r => setTimeout(r, 30))
				controller.enqueue(encoder.encode(
					'event: content_block_delta\n' +
					`data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}\n\n`
				))
			} else {
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

class MockProvider extends Provider {
	name = 'mock'

	async fetch(body: any, _signal?: AbortSignal) {
		const chunks = generateResponse(body.messages ?? [])
		const stream = makeSSEStream(chunks)
		return new Response(stream, {
			status: 200,
			headers: { 'Content-Type': 'text/event-stream' },
		})
	}

	buildRequestBody({ model, messages, system, tools, maxTokens }: any) {
		return { model, messages, system, tools, max_tokens: maxTokens }
	}

	async complete({ userMessage }: any) {
		return { text: `[mock] echo: ${userMessage.slice(0, 200)}` }
	}
}

export const mockProvider = new MockProvider()
