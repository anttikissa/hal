// OpenAI-compatible Chat Completions provider (OpenRouter, Ollama and
// other local servers). Wire mapping: tasks/7f/mapping.md.

import type { StopReason, StreamEvent, Usage } from '../common/blocks.ts'
import { provider, type Provider, type ProviderRequest, type SseMessage } from './provider.ts'

// keyEnv names the environment variable holding the API key; without
// one (local servers) no Authorization header is sent.
export type Endpoint = { baseUrl: string; keyEnv?: string }

function toMessages(req: ProviderRequest): unknown[] {
	let out: unknown[] = []
	if (req.system) out.push({ role: 'system', content: req.system })
	for (let msg of req.messages) {
		if (msg.role === 'user') {
			// Tool results must directly follow the assistant's tool_calls.
			let texts: string[] = []
			for (let b of msg.blocks) {
				if (b.type === 'text') texts.push(b.text)
				else out.push({ role: 'tool', tool_call_id: b.id, content: b.isError ? `Error: ${b.output}` : b.output })
			}
			if (texts.length) out.push({ role: 'user', content: texts.join('\n\n') })
			continue
		}
		// Thinking is dropped: Chat Completions has no reasoning input.
		let text = ''
		let calls: unknown[] = []
		for (let b of msg.blocks) {
			if (b.type === 'text') text += b.text
			else if (b.type === 'tool_call') calls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input) } })
		}
		out.push(calls.length ? { role: 'assistant', content: text || null, tool_calls: calls } : { role: 'assistant', content: text })
	}
	return out
}

function body(req: ProviderRequest): Record<string, unknown> {
	let b: Record<string, unknown> = {
		model: req.model,
		messages: openaiCompat.toMessages(req),
		stream: true,
		stream_options: { include_usage: true },
	}
	if (req.maxTokens) b.max_tokens = req.maxTokens
	if (req.tools?.length) {
		b.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }))
	}
	return b
}

const reasons: Record<string, StopReason> = {
	stop: 'end',
	tool_calls: 'tool_use',
	function_call: 'tool_use',
	length: 'max_tokens',
	content_filter: 'refusal',
}

function usage(u: any): Usage {
	let cached = u.prompt_tokens_details?.cached_tokens ?? 0
	let out: Usage = {}
	if (typeof u.prompt_tokens === 'number') out.input = Math.max(0, u.prompt_tokens - cached)
	if (typeof u.completion_tokens === 'number') out.output = u.completion_tokens
	if (cached) out.cacheRead = cached
	return out
}

// Tool calls arrive as fragments keyed by index and are emitted whole
// at finish_reason. Usage follows in its own chunk, so done waits for
// [DONE] (or the end of the stream, for servers that omit it).
async function* parse(messages: AsyncIterable<SseMessage>): AsyncGenerator<StreamEvent> {
	let calls = new Map<number, { id: string; name: string; args: string }>()
	let reason: StopReason | undefined
	for await (let m of messages) {
		if (m.data === '[DONE]') break
		let chunk = JSON.parse(m.data)
		if (chunk.error) {
			let e = chunk.error
			yield { type: 'error', message: typeof e === 'string' ? e : (e.message ?? 'Unknown error'), body: m.data }
			return
		}
		let choice = chunk.choices?.[0]
		let delta = choice?.delta
		let thinking = delta?.reasoning ?? delta?.reasoning_content
		if (thinking) yield { type: 'thinking', text: thinking }
		if (delta?.content) yield { type: 'text', text: delta.content }
		for (let tc of delta?.tool_calls ?? []) {
			let index = tc.index ?? 0
			let call = calls.get(index) ?? { id: '', name: '', args: '' }
			calls.set(index, call)
			if (tc.id) call.id = tc.id
			if (tc.function?.name) call.name = tc.function.name
			if (tc.function?.arguments) call.args += tc.function.arguments
		}
		if (choice?.finish_reason && !reason) {
			reason = reasons[choice.finish_reason] ?? 'end'
			for (let [index, call] of [...calls].sort((a, b) => a[0] - b[0])) {
				let input: unknown
				try {
					input = JSON.parse(call.args || '{}')
				} catch {}
				if (!input || typeof input !== 'object' || Array.isArray(input)) {
					yield { type: 'error', message: `Invalid JSON arguments for tool call '${call.name}'`, body: call.args }
					return
				}
				yield { type: 'tool_call', id: call.id || `call_${index}`, name: call.name, input: input as Record<string, unknown> }
			}
		}
		if (chunk.usage) yield { type: 'usage', usage: usage(chunk.usage) }
	}
	if (reason) yield { type: 'done', reason }
}

function create(name: string): Provider {
	return {
		request(req) {
			// Read at call time so local.ts and env changes apply.
			let ep = openaiCompat.endpoints()[name]
			if (!ep) throw new Error(`No endpoint configured for '${name}'`)
			let headers: Record<string, string> = {}
			if (ep.keyEnv) {
				let key = process.env[ep.keyEnv]
				if (!key) throw new Error(`No API key for '${name}': set ${ep.keyEnv}`)
				headers.authorization = `Bearer ${key}`
			}
			return { url: `${ep.baseUrl.replace(/\/+$/, '')}/chat/completions`, headers, body: openaiCompat.body(req) }
		},
		parse: openaiCompat.parse,
	}
}

// Registers one provider per configured endpoint. Idempotent.
function init(): void {
	for (let name of Object.keys(openaiCompat.endpoints())) provider.register(name, openaiCompat.create(name))
}

export const openaiCompat = {
	// Provider name -> endpoint. Replace from local.ts to add servers or
	// point one elsewhere.
	endpoints(): Record<string, Endpoint> {
		return {
			openrouter: { baseUrl: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY' },
			ollama: { baseUrl: 'http://localhost:11434/v1' },
		}
	},
	toMessages,
	body,
	parse,
	create,
	init,
}
