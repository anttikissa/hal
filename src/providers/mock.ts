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
	'**error** — I will simulate a stream error\n',
	'**tool** — I will simulate a tool call\n',
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

function makeToolStream(): ReadableStream<Uint8Array> {
	const enc = new TextEncoder()
	const sse = (event: string, data: any) => enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
	const input = JSON.stringify({ command: 'for i in $(seq 1 10); do echo $i; sleep 0.5; done' })
	let step = 0
	return new ReadableStream({
		async pull(c) {
			switch (step++) {
				case 0:
					c.enqueue(sse('message_start', { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } }))
					c.enqueue(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text' } }))
					c.enqueue(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me count to 10.\n' } }))
					c.enqueue(sse('content_block_stop', { type: 'content_block_stop', index: 0 }))
					break
				case 1:
					c.enqueue(sse('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'mock_tool_1', name: 'bash' } }))
					break
				case 2:
					await new Promise(r => setTimeout(r, 50))
					c.enqueue(sse('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: input } }))
					c.enqueue(sse('content_block_stop', { type: 'content_block_stop', index: 1 }))
					break
				case 3:
					c.enqueue(sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } }))
					c.close()
					break
			}
		},
	})
}

type MockResponse = { chunks: string[]; delayMs: number; error?: boolean; tool?: boolean }
function generateResponse(messages: any[]): MockResponse {
	const hasToolResult = messages.some((m: any) => m.role === 'user' && Array.isArray(m.content) && m.content.some((c: any) => c.type === 'tool_result'))
	const input = lastUserText(messages)
	if (input.startsWith('song')) return { chunks: DAISY_BELL, delayMs: 120 }
	if (input.startsWith('error')) return { chunks: [], delayMs: 0, error: true }
	if (input.startsWith('tool') && !hasToolResult) return { chunks: [], delayMs: 0, tool: true }
	return { chunks: GREETING, delayMs: 30 }
}

class MockProvider extends Provider {
	name = 'mock'

	async fetch(body: any, _signal?: AbortSignal) {
		const { chunks, delayMs, error, tool } = generateResponse(body.messages ?? [])
		if (error) {
			return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Mock error' } }), {
				status: 400, headers: { 'Content-Type': 'application/json' },
			})
		}
		const stream = tool ? makeToolStream() : makeSSEStream(chunks, delayMs)
		return new Response(stream, {
			status: 200, headers: { 'Content-Type': 'text/event-stream' },
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
