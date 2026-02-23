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

const DAISY_BELL = [
	'Dai', 'sy, ', 'Dai', 'sy, ',
	'give ', 'me ', 'your ', 'an', 'swer, ', 'do.\n',
	"I'm ", 'half ', 'cra', 'zy, ',
	'all ', 'for ', 'the ', 'love ', 'of ', 'you.\n',
	'It ', "won't ", 'be ', 'a ', 'sty', 'lish ', 'mar', 'riage—\n',
	'I ', "can't ", 'af', 'ford ', 'a ', 'car', 'riage,\n',
	'But ', "you'll ", 'look ', 'sweet ',
	'u', 'pon ', 'the ', 'seat\n',
	'of ', 'a ', 'bi', 'cy', 'cle ',
	'built ', 'for ', 'two.\n',
]

/** Build a ReadableStream that emits Anthropic-format SSE for a text response */
function makeSSEStream(chunks: string[], delayMs: number): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder()
	let index = 0

	function sse(event: string, data: any): Uint8Array {
		return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
	}

	return new ReadableStream({
		async pull(controller) {
			if (index === 0) {
				controller.enqueue(sse('message_start', {
					type: 'message_start',
					message: { usage: { input_tokens: 10, output_tokens: 0 } },
				}))
				controller.enqueue(sse('content_block_start', {
					type: 'content_block_start', index: 0, content_block: { type: 'text' },
				}))
			}

			if (index < chunks.length) {
				const text = chunks[index++]
				await new Promise(r => setTimeout(r, delayMs))
				controller.enqueue(sse('content_block_delta', {
					type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text },
				}))
			} else {
				controller.enqueue(sse('content_block_stop', {
					type: 'content_block_stop', index: 0,
				}))
				controller.enqueue(sse('message_delta', {
					type: 'message_delta',
					delta: { stop_reason: 'end_turn' },
					usage: { output_tokens: chunks.length * 5 },
				}))
				controller.close()
			}
		},
	})
}

/** Extract the last user message text */
function lastUserText(messages: any[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i]
		if (msg.role !== 'user') continue
		if (typeof msg.content === 'string') return msg.content.trim().toLowerCase()
		if (Array.isArray(msg.content)) {
			const text = msg.content.find((b: any) => b.type === 'text')
			if (text) return text.text.trim().toLowerCase()
		}
	}
	return ''
}

function generateResponse(messages: any[]): { chunks: string[]; delayMs: number } {
	const input = lastUserText(messages)
	if (input.startsWith('song')) {
		return { chunks: DAISY_BELL, delayMs: 120 }
	}
	return { chunks: GREETING, delayMs: 30 }
}

class MockProvider extends Provider {
	name = 'mock'

	async fetch(body: any, _signal?: AbortSignal) {
		const { chunks, delayMs } = generateResponse(body.messages ?? [])
		const stream = makeSSEStream(chunks, delayMs)
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
