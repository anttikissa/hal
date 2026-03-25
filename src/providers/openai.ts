// OpenAI + compat provider — Chat Completions API streaming.
//
// Handles OpenAI native and compatible endpoints (OpenRouter, Google, Grok,
// Ollama, etc.) via a single implementation. No SDK dependency — uses raw
// fetch + SSE parsing for maximum compatibility.
//
// OpenAI native uses the Responses API for models that support it.
// Compat endpoints use the Chat Completions API.

import type { Provider, ProviderRequest, ProviderStreamEvent, Message } from '../protocol.ts'
import { provider as providerUtils } from './provider.ts'
import { auth } from '../auth.ts'

// ── Endpoint configuration ──

const COMPAT_ENDPOINTS: Record<string, string> = {
	openrouter: 'https://openrouter.ai/api/v1',
	google: 'https://generativelanguage.googleapis.com/v1beta/openai',
	grok: 'https://api.x.ai/v1',
}

function getApiKey(providerName: string): string | undefined {
	return auth.getCredential(providerName)?.value
}

// ── Message conversion (Anthropic format → Chat Completions format) ──
// Our internal message format follows Anthropic's structure (content blocks).
// This converts to OpenAI's Chat Completions format.

function convertMessages(msgs: Message[]): any[] {
	const out: any[] = []

	for (const msg of msgs) {
		if (msg.role === 'user') {
			if (typeof msg.content === 'string') {
				out.push({ role: 'user', content: msg.content })
			} else if (Array.isArray(msg.content)) {
				const toolResults = (msg.content as any[]).filter((b: any) => b.type === 'tool_result')
				const others = (msg.content as any[]).filter((b: any) => b.type !== 'tool_result')

				// Tool results become separate "tool" role messages
				for (const tr of toolResults) {
					out.push({
						role: 'tool',
						tool_call_id: tr.tool_use_id,
						content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content),
					})
				}

				// Other content (text, images) becomes a user message
				if (others.length > 0) {
					const parts: any[] = []
					for (const b of others) {
						if (b.type === 'text') {
							parts.push({ type: 'text', text: b.text })
						} else if (b.type === 'image') {
							const src = b.source
							if (src?.type === 'base64') {
								parts.push({
									type: 'image_url',
									image_url: { url: `data:${src.media_type};base64,${src.data}` },
								})
							}
						}
					}
					if (parts.length === 1 && parts[0].type === 'text') {
						out.push({ role: 'user', content: parts[0].text })
					} else if (parts.length > 0) {
						out.push({ role: 'user', content: parts })
					}
				}
			}
		} else if (msg.role === 'assistant') {
			if (typeof msg.content === 'string') {
				out.push({ role: 'assistant', content: msg.content })
			} else if (Array.isArray(msg.content)) {
				let text = ''
				const toolCalls: any[] = []
				for (const b of msg.content as any[]) {
					if (b.type === 'text') text += b.text
					else if (b.type === 'tool_use') {
						toolCalls.push({
							id: b.id,
							type: 'function',
							function: { name: b.name, arguments: JSON.stringify(b.input) },
						})
					}
					// thinking blocks are skipped — not part of Chat Completions
				}
				const m: any = { role: 'assistant' }
				if (text) m.content = text
				if (toolCalls.length) m.tool_calls = toolCalls
				if (!text && !toolCalls.length) m.content = ''
				out.push(m)
			}
		}
	}

	return out
}

/** Convert our ToolDef[] (Anthropic format) to OpenAI function tools. */
function convertTools(tools: any[]): any[] {
	return tools.map(t => ({
		type: 'function',
		function: {
			name: t.name,
			description: t.description,
			parameters: t.input_schema ?? t.parameters,
		},
	}))
}

// ── Chat Completions SSE parser ──
// Handles streaming responses from any Chat Completions-compatible endpoint.

async function* parseChatCompletionsStream(
	body: ReadableStream<Uint8Array>,
): AsyncGenerator<ProviderStreamEvent> {
	const reader = body.getReader()
	const decoder = new TextDecoder()
	let buf = ''
	let inputTokens = 0
	let outputTokens = 0

	// Tool calls are streamed incrementally across multiple chunks
	const toolCalls = new Map<number, { id: string; name: string; args: string }>()

	try {
		while (true) {
			const { done, value } = await providerUtils.readWithTimeout(reader)
			if (done) break
			buf += decoder.decode(value, { stream: true })

			let nl: number
			while ((nl = buf.indexOf('\n')) !== -1) {
				const line = buf.slice(0, nl).trim()
				buf = buf.slice(nl + 1)
				if (!line.startsWith('data: ')) continue
				const data = line.slice(6)
				if (data === '[DONE]') continue

				let chunk: any
				try { chunk = JSON.parse(data) } catch { continue }

				const choice = chunk.choices?.[0]
				if (!choice) {
					// Usage-only chunk (some providers send this separately)
					if (chunk.usage) {
						inputTokens = chunk.usage.prompt_tokens ?? 0
						outputTokens = chunk.usage.completion_tokens ?? 0
					}
					continue
				}

				const delta = choice.delta
				if (delta?.content) yield { type: 'text', text: delta.content }

				// Tool calls are streamed as incremental argument chunks
				if (delta?.tool_calls) {
					for (const tc of delta.tool_calls) {
						const idx = tc.index ?? 0
						if (tc.id) {
							toolCalls.set(idx, { id: tc.id, name: tc.function?.name ?? '', args: '' })
						}
						const entry = toolCalls.get(idx)
						if (entry) {
							if (tc.function?.name) entry.name = tc.function.name
							if (tc.function?.arguments) entry.args += tc.function.arguments
						}
					}
				}

				// Capture usage from the final chunk
				if (choice.finish_reason === 'stop' || choice.finish_reason === 'tool_calls') {
					if (chunk.usage) {
						inputTokens = chunk.usage.prompt_tokens ?? 0
						outputTokens = chunk.usage.completion_tokens ?? 0
					}
				}
			}
		}
	} finally {
		reader.releaseLock()
	}

	// Emit all accumulated tool calls at stream end
	for (const [, tc] of toolCalls) {
		try {
			const input = JSON.parse(tc.args)
			yield { type: 'tool_call', id: tc.id, name: tc.name, input }
		} catch {
			yield {
				type: 'tool_call', id: tc.id, name: tc.name, input: {},
				parseError: `Failed to parse tool input JSON (${tc.args.length} chars): ${tc.args.slice(0, 200)}`,
			}
		}
	}

	yield {
		type: 'done',
		usage: (inputTokens || outputTokens) ? { input: inputTokens, output: outputTokens } : undefined,
	}
}

// ── Chat Completions generate (compat endpoints) ──

async function* generateCompat(
	providerName: string,
	baseUrl: string,
	req: ProviderRequest,
): AsyncGenerator<ProviderStreamEvent> {
	// Refresh OAuth token if needed (e.g. OpenAI Codex tokens expire)
	await auth.ensureFresh(providerName)
	const apiKey = getApiKey(providerName)
	if (!apiKey) {
		yield { type: 'error', message: `No credentials for '${providerName}'. Run: bun scripts/login-openai.ts (or set ${providerName.toUpperCase()}_API_KEY)` }
		yield { type: 'done' }
		return
	}

	const messages = convertMessages(req.messages)
	const body: any = {
		model: req.model,
		messages: [{ role: 'system', content: req.systemPrompt }, ...messages],
		stream: true,
	}
	if (req.tools?.length) {
		body.tools = convertTools(req.tools)
	}

	const res = await fetch(`${baseUrl}/chat/completions`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${apiKey}`,
		},
		body: JSON.stringify(body),
		signal: req.signal,
	})

	if (!res.ok) {
		const text = (await res.text()).slice(0, 2000)
		const retryAfterMs = providerUtils.parseRetryDelay(res, text)
		yield { type: 'error', message: `${providerName} ${res.status}: ${res.statusText}`, status: res.status, body: text, retryAfterMs }
		yield { type: 'done' }
		return
	}

	yield* parseChatCompletionsStream(res.body!)
}

// ── OpenAI native (Chat Completions, not Responses API) ──
// Using Chat Completions for simplicity. Can upgrade to Responses API later.

async function* generateOpenAI(req: ProviderRequest): AsyncGenerator<ProviderStreamEvent> {
	yield* generateCompat('openai', 'https://api.openai.com/v1', req)
}

// ── Exports ──

export const openaiProvider: Provider = { generate: generateOpenAI }

/** Create a Chat Completions-compatible provider for any endpoint. */
export function createCompatProvider(providerName: string, baseUrl?: string): Provider {
	const url = baseUrl ?? COMPAT_ENDPOINTS[providerName]
	if (!url) {
		throw new Error(
			`Unknown compat provider '${providerName}'. ` +
			`Known endpoints: ${Object.keys(COMPAT_ENDPOINTS).join(', ')}. ` +
			`Or pass a custom baseUrl.`
		)
	}
	return {
		generate: (req) => generateCompat(providerName, url, req),
	}
}

export const openai = {
	openaiProvider,
	createCompatProvider,
	convertMessages,
	convertTools,
	COMPAT_ENDPOINTS,
}
