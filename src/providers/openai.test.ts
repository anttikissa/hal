import { test, expect } from 'bun:test'

function makeSSE(events: any[]): string {
	return events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('')
}

function installFetchMock(fn: (input: any, init?: any) => Promise<Response>): typeof fetch {
	const origFetch = globalThis.fetch
	globalThis.fetch = Object.assign(fn, { preconnect: () => {} }) as typeof fetch
	return origFetch
}

function mockFetch(sseEvents: any[]) {
	const sse = makeSSE(sseEvents)
	const origFetch = installFetchMock(async (input: any) => {
		const url = typeof input === 'string' ? input : input.url
		// Let auth refresh "succeed" with no-op
		if (url.includes('auth.openai.com')) {
			return new Response(JSON.stringify({ access_token: 'test-token', refresh_token: 'test-refresh', expires_in: 3600 }), { status: 200 }) as any
		}
		// API call returns SSE stream
		return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }) as any
	})
	return origFetch
}

function mockFetchError(status: number, body: string) {
	const origFetch = installFetchMock(async (input: any) => {
		const url = typeof input === 'string' ? input : input.url
		if (url.includes('auth.openai.com')) {
			return new Response(JSON.stringify({ access_token: 'test-token', refresh_token: 'test-refresh', expires_in: 3600 }), { status: 200 }) as any
		}
		return new Response(body, { status }) as any
	})
	return origFetch
}

test('openai provider: parses text response', async () => {
	const events = [
		{ type: 'response.output_item.added', output_index: 0, item: { type: 'message' } },
		{ type: 'response.output_text.delta', output_index: 0, delta: 'Hello ' },
		{ type: 'response.output_text.delta', output_index: 0, delta: 'world' },
		{ type: 'response.output_item.done', output_index: 0 },
		{ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 100, output_tokens: 20 } } },
	]

	const origFetch = mockFetch(events)
	try {
		const mod = await import('./openai.ts')
		const provider = mod.default
		const collected: any[] = []
		for await (const event of provider.generate({
			messages: [{ role: 'user', content: 'hi' }],
			model: 'gpt-5.4',
			systemPrompt: 'You are helpful.',
			tools: [],
		})) {
			collected.push(event)
		}

		const texts = collected.filter(e => e.type === 'text')
		expect(texts.map(t => t.text).join('')).toBe('Hello world')

		const done = collected.find(e => e.type === 'done')
		expect(done).toBeTruthy()
		expect(done.usage.input).toBe(100)
		expect(done.usage.output).toBe(20)
	} finally {
		globalThis.fetch = origFetch
	}
})

test('openai provider: parses tool call', async () => {
	const events = [
		{ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call_1', name: 'bash' } },
		{ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"comma' },
		{ type: 'response.function_call_arguments.delta', output_index: 0, delta: 'nd":"ls"}' },
		{ type: 'response.output_item.done', output_index: 0 },
		{ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 50, output_tokens: 10 } } },
	]

	const origFetch = mockFetch(events)
	try {
		const mod = await import('./openai.ts')
		const provider = mod.default
		const collected: any[] = []
		for await (const event of provider.generate({
			messages: [],
			model: 'gpt-5.3',
			systemPrompt: 'test',
			tools: [{ name: 'bash', description: 'Run bash', input_schema: { type: 'object', properties: { command: { type: 'string' } } } }],
		})) {
			collected.push(event)
		}

		const toolCall = collected.find(e => e.type === 'tool_call')
		expect(toolCall).toBeTruthy()
		expect(toolCall.id).toBe('call_1')
		expect(toolCall.name).toBe('bash')
		expect(toolCall.input).toEqual({ command: 'ls' })
	} finally {
		globalThis.fetch = origFetch
	}
})

test('openai provider: parses reasoning as thinking', async () => {
	const events = [
		{ type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning' } },
		{ type: 'response.reasoning_summary_text.delta', output_index: 0, delta: 'Let me think...' },
		{ type: 'response.reasoning_summary_part.done', output_index: 0 },
		{ type: 'response.output_item.done', output_index: 0 },
		{ type: 'response.output_item.added', output_index: 1, item: { type: 'message' } },
		{ type: 'response.output_text.delta', output_index: 1, delta: 'Answer' },
		{ type: 'response.output_item.done', output_index: 1 },
		{ type: 'response.completed', response: { status: 'completed' } },
	]

	const origFetch = mockFetch(events)
	try {
		const mod = await import('./openai.ts')
		const provider = mod.default
		const collected: any[] = []
		for await (const event of provider.generate({
			messages: [],
			model: 'gpt-5.4',
			systemPrompt: 'test',
		})) {
			collected.push(event)
		}

		const thinkingTexts = collected.filter(e => e.type === 'thinking').map(e => e.text)
		expect(thinkingTexts.join('')).toContain('Let me think...')

		const textEvents = collected.filter(e => e.type === 'text')
		expect(textEvents.map(e => e.text).join('')).toBe('Answer')
	} finally {
		globalThis.fetch = origFetch
	}
})

test('openai provider: captures reasoning signature from output item', async () => {
	const events = [
		{ type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning' } },
		{ type: 'response.reasoning_summary_text.delta', output_index: 0, delta: 'Planning...' },
		{
			type: 'response.output_item.done',
			output_index: 0,
			item: { type: 'reasoning', id: 'rs_123', encrypted_content: 'enc_abc' },
		},
		{ type: 'response.completed', response: { status: 'completed' } },
	]

	const origFetch = mockFetch(events)
	try {
		const mod = await import('./openai.ts')
		const provider = mod.default
		const collected: any[] = []
		for await (const event of provider.generate({
			messages: [],
			model: 'gpt-5.4',
			systemPrompt: 'test',
		})) {
			collected.push(event)
		}

		const signature = collected.find(e => e.type === 'thinking_signature')
		expect(signature).toBeTruthy()
		const parsed = JSON.parse(signature.signature)
		expect(parsed.type).toBe('reasoning')
		expect(parsed.encrypted_content).toBe('enc_abc')
	} finally {
		globalThis.fetch = origFetch
	}
})

test('openai provider: replays reasoning signature in input', async () => {
	const sse = makeSSE([{ type: 'response.completed', response: { status: 'completed' } }])
	let requestBody: any = null
	const origFetch = installFetchMock(async (input: any, init?: any) => {
		const url = typeof input === 'string' ? input : input.url
		if (url.includes('auth.openai.com')) {
			return new Response(JSON.stringify({ access_token: 'test-token', refresh_token: 'test-refresh', expires_in: 3600 }), { status: 200 }) as any
		}
		requestBody = JSON.parse(String(init?.body ?? '{}'))
		return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }) as any
	})

	try {
		const mod = await import('./openai.ts')
		const provider = mod.default
		const reasoning = { type: 'reasoning', id: 'rs_prev', encrypted_content: 'enc_prev' }
		for await (const _event of provider.generate({
			messages: [{
				role: 'assistant',
				content: [{ type: 'thinking', thinking: 'previous thought', signature: JSON.stringify(reasoning) }],
			}],
			model: 'gpt-5.4',
			systemPrompt: 'test',
		})) {
			// drain stream
		}

		expect(requestBody).toBeTruthy()
		expect(requestBody.input).toContainEqual(reasoning)
	} finally {
		globalThis.fetch = origFetch
	}
})

test('openai provider: deduplicates reasoning items by id', async () => {
	const sse = makeSSE([{ type: 'response.completed', response: { status: 'completed' } }])
	let requestBody: any = null
	const origFetch = installFetchMock(async (input: any, init?: any) => {
		const url = typeof input === 'string' ? input : input.url
		if (url.includes('auth.openai.com')) {
			return new Response(JSON.stringify({ access_token: 'test-token', refresh_token: 'test-refresh', expires_in: 3600 }), { status: 200 }) as any
		}
		requestBody = JSON.parse(String(init?.body ?? '{}'))
		return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }) as any
	})

	try {
		const mod = await import('./openai.ts')
		const provider = mod.default
		const reasoning = { type: 'reasoning', id: 'rs_dup', encrypted_content: 'enc_dup' }
		// Two assistant messages with the same reasoning signature (e.g. after fork)
		for await (const _event of provider.generate({
			messages: [
				{ role: 'assistant', content: [{ type: 'thinking', thinking: 'thought 1', signature: JSON.stringify(reasoning) }, { type: 'text', text: 'reply 1' }] },
				{ role: 'user', content: 'follow-up' },
				{ role: 'assistant', content: [{ type: 'thinking', thinking: 'thought 2', signature: JSON.stringify(reasoning) }, { type: 'text', text: 'reply 2' }] },
			],
			model: 'gpt-5.4',
			systemPrompt: 'test',
		})) {
			// drain
		}

		expect(requestBody).toBeTruthy()
		const reasoningItems = requestBody.input.filter((i: any) => i.type === 'reasoning')
		expect(reasoningItems).toHaveLength(1)
		expect(reasoningItems[0].id).toBe('rs_dup')
	} finally {
		globalThis.fetch = origFetch
	}
})

test('openai provider: handles API error', async () => {
	const origFetch = mockFetchError(429, '{"error": "rate limited"}')
	try {
		const mod = await import('./openai.ts')
		const provider = mod.default
		const collected: any[] = []
		for await (const event of provider.generate({
			messages: [],
			model: 'gpt-5.2',
			systemPrompt: 'test',
		})) {
			collected.push(event)
		}

		const error = collected.find(e => e.type === 'error')
		expect(error).toBeTruthy()
		expect(error.message).toContain('429')

		const done = collected.find(e => e.type === 'done')
		expect(done).toBeTruthy()
	} finally {
		globalThis.fetch = origFetch
	}
})
