// OpenAI Chat Completions-compatible provider adapter.
// Works with OpenRouter, Gemini, Grok, Ollama, and any compatible endpoint.

import type { Provider, ProviderEvent, GenerateParams } from './provider.ts'
import { readWithTimeout } from './provider.ts'
import { auth } from '../runtime/auth.ts'

const ENDPOINTS: Record<string, string> = {
	openrouter: 'https://openrouter.ai/api/v1',
	gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
	grok: 'https://api.x.ai/v1',
}

function getApiKey(providerName: string): string {
	const a = auth.getAuth(providerName)
	const key = a.apiKey ?? a.accessToken
	if (!key) throw new Error(`No API key for '${providerName}'. Set ${providerName}: { apiKey: "..." } in auth.ason`)
	return key
}

// Convert Anthropic-format messages (from api-messages.ts) to Chat Completions format
function convertMessages(messages: any[]): any[] {
	const out: any[] = []
	for (const msg of messages) {
		if (msg.role === 'user') {
			if (typeof msg.content === 'string') {
				out.push({ role: 'user', content: msg.content })
			} else if (Array.isArray(msg.content)) {
				// May contain text, tool_result, or image blocks
				const toolResults = msg.content.filter((b: any) => b.type === 'tool_result')
				const others = msg.content.filter((b: any) => b.type !== 'tool_result')

				// Tool results become separate messages
				for (const tr of toolResults) {
					out.push({
						role: 'tool',
						tool_call_id: tr.tool_use_id,
						content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content),
					})
				}

				if (others.length > 0) {
					const parts: any[] = []
					for (const b of others) {
						if (b.type === 'text') {
							parts.push({ type: 'text', text: b.text })
						} else if (b.type === 'image') {
							const src = b.source
							if (src?.type === 'base64') {
								parts.push({ type: 'image_url', image_url: { url: `data:${src.media_type};base64,${src.data}` } })
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
				for (const b of msg.content) {
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

async function* generate(providerName: string, baseUrl: string, params: GenerateParams): AsyncGenerator<ProviderEvent> {
	const apiKey = getApiKey(providerName)
	const messages = convertMessages(params.messages)
	const body: any = {
		model: params.model,
		messages: [{ role: 'system', content: params.systemPrompt }, ...messages],
		stream: true,
	}
	if (params.tools?.length) body.tools = convertTools(params.tools)

	const res = await fetch(`${baseUrl}/chat/completions`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${apiKey}`,
		},
		body: JSON.stringify(body),
		signal: params.signal,
	})

	if (!res.ok) {
		const text = await res.text().catch(() => '')
		yield { type: 'error', message: `${providerName} ${res.status}: ${res.statusText}`, status: res.status, body: text }
		return
	}

	const reader = res.body!.getReader()
	const decoder = new TextDecoder()
	let buf = ''
	let inputTokens = 0
	let outputTokens = 0

	// Accumulate tool calls across chunks (streamed incrementally)
	const toolCalls = new Map<number, { id: string; name: string; args: string }>()

	try {
		while (true) {
			const { done, value } = await readWithTimeout(reader)
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
					if (chunk.usage) {
						inputTokens = chunk.usage.prompt_tokens ?? 0
						outputTokens = chunk.usage.completion_tokens ?? 0
					}
					continue
				}

				const delta = choice.delta
				if (delta?.content) yield { type: 'text', text: delta.content }

				// Tool calls are streamed as incremental chunks
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

	// Emit accumulated tool calls
	for (const [, tc] of toolCalls) {
		let input: unknown = {}
		try { input = JSON.parse(tc.args) } catch { input = tc.args }
		yield { type: 'tool_call', id: tc.id, name: tc.name, input }
	}

	yield { type: 'done', usage: (inputTokens || outputTokens) ? { input: inputTokens, output: outputTokens } : undefined }
}

export function createOpenAICompatProvider(providerName: string, baseUrl?: string): Provider {
	const url = baseUrl ?? ENDPOINTS[providerName]
	if (!url) throw new Error(`Unknown provider '${providerName}'. Set a base URL or use: ${Object.keys(ENDPOINTS).join(', ')}`)
	return {
		name: providerName,
		generate: (params) => generate(providerName, url, params),
	}
}

export const openaiCompat = { createOpenAICompatProvider, convertMessages, convertTools, ENDPOINTS }
