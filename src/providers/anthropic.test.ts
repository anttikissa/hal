import { test, expect } from 'bun:test'

function installFetchMock(fn: (input: any, init?: any) => Promise<Response>): typeof fetch {
	const origFetch = globalThis.fetch
	globalThis.fetch = Object.assign(fn, { preconnect: () => {} }) as typeof fetch
	return origFetch
}

function anthropicSse(): string {
	return [
		'data: {"type":"message_start","message":{"usage":{"input_tokens":1}}}',
		'data: {"type":"message_delta","usage":{"output_tokens":1}}',
		'',
	].join('\n')
}

test('anthropic provider: converts OpenAI reasoning signatures into assistant text context', async () => {
	let requestBody: any = null
	const origFetch = installFetchMock(async (input: any, init?: any) => {
		const url = typeof input === 'string' ? input : input.url
		if (url.includes('console.anthropic.com/v1/oauth/token')) {
			return new Response(JSON.stringify({ access_token: 'test-token', refresh_token: 'test-refresh', expires_in: 3600 }), { status: 200 }) as any
		}
		if (url.includes('api.anthropic.com/v1/messages')) {
			requestBody = JSON.parse(String(init?.body ?? '{}'))
			return new Response(anthropicSse(), { status: 200, headers: { 'content-type': 'text/event-stream' } }) as any
		}
		throw new Error(`Unexpected URL: ${url}`)
	})
	try {
		const mod = await import('./anthropic.ts')
		const provider = mod.default
		const signature = JSON.stringify({ id: 'rs_prev', type: 'reasoning', encrypted_content: 'enc_prev' })
		for await (const _event of provider.generate({
			messages: [{
				role: 'assistant',
				content: [
					{ type: 'thinking', thinking: 'old thought', signature, _model: 'openai/gpt-5.4' },
					{ type: 'text', text: 'hello' },
				],
			}],
			model: 'claude-opus-4-6',
			systemPrompt: 'test',
			tools: [],
			sessionId: 'sid-test',
		})) {
			// drain
		}

		expect(requestBody).toBeTruthy()
		const blocks = requestBody.messages[0].content
		expect(blocks.some((b: any) => b.type === 'thinking')).toBe(false)
		expect(blocks.some((b: any) => b.type === 'text' && b.text === 'hello')).toBe(true)
		expect(blocks.some((b: any) => b.type === 'text' && String(b.text).includes('[model openai/gpt-5.4 thinking]'))).toBe(true)
		expect(blocks.some((b: any) => b.type === 'text' && String(b.text).includes('old thought'))).toBe(true)
	} finally {
		globalThis.fetch = origFetch
	}
})

test('anthropic provider: keeps native thinking signatures', async () => {
	let requestBody: any = null
	const origFetch = installFetchMock(async (input: any, init?: any) => {
		const url = typeof input === 'string' ? input : input.url
		if (url.includes('console.anthropic.com/v1/oauth/token')) {
			return new Response(JSON.stringify({ access_token: 'test-token', refresh_token: 'test-refresh', expires_in: 3600 }), { status: 200 }) as any
		}
		if (url.includes('api.anthropic.com/v1/messages')) {
			requestBody = JSON.parse(String(init?.body ?? '{}'))
			return new Response(anthropicSse(), { status: 200, headers: { 'content-type': 'text/event-stream' } }) as any
		}
		throw new Error(`Unexpected URL: ${url}`)
	})
	try {
		const mod = await import('./anthropic.ts')
		const provider = mod.default
		const signature = 'EuwDCkYICxgCKkD/rBpHfOrn+vbNPIjqR4hG5D7cRe8='
		for await (const _event of provider.generate({
			messages: [{
				role: 'assistant',
				content: [
					{ type: 'thinking', thinking: 'native thought', signature, _model: 'anthropic/claude-opus-4-6' },
					{ type: 'text', text: 'hello' },
				],
			}],
			model: 'claude-opus-4-6',
			systemPrompt: 'test',
			tools: [],
			sessionId: 'sid-test',
		})) {
			// drain
		}

		expect(requestBody).toBeTruthy()
		const blocks = requestBody.messages[0].content
		expect(blocks[0]).toMatchObject({ type: 'thinking', thinking: 'native thought', signature })
		expect(blocks[0]._model).toBeUndefined()
	} finally {
		globalThis.fetch = origFetch
	}
})
