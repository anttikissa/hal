// OpenAI provider — streams Responses API as ProviderEvents.

import type { Provider, ProviderEvent, GenerateParams } from './provider.ts'
import { readWithTimeout } from './provider.ts'
import { getAuth, refreshOpenAIAuth, extractOpenAIAccountId, isApiKey, openaiUsesCodex } from '../runtime/auth.ts'

const RESPONSES_API_URL = 'https://api.openai.com/v1/responses'
const CODEX_BASE_URL = 'https://chatgpt.com/backend-api'

function resolveApiUrl(token: string): string {
	if (openaiUsesCodex(token)) return `${CODEX_BASE_URL}/codex/responses`
	return RESPONSES_API_URL
}

// ── Message conversion (Anthropic → OpenAI Responses API) ──

function convertMessages(messages: any[]): any[] {
	const input: any[] = []
	for (const msg of messages) {
		if (msg.role === 'user') {
			if (Array.isArray(msg.content)) {
				const toolResults = msg.content.filter((b: any) => b.type === 'tool_result')
				if (toolResults.length > 0) {
					for (const tr of toolResults) {
						input.push({
							type: 'function_call_output',
							call_id: tr.tool_use_id,
							output: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content),
						})
					}
					continue
				}
				const parts = msg.content.map((b: any) => {
					if (b.type === 'text') return { type: 'input_text', text: b.text }
					if (b.type === 'image') {
						return {
							type: 'input_image',
							detail: 'auto',
							image_url: `data:${b.source?.media_type ?? 'image/png'};base64,${b.source?.data ?? b.data}`,
						}
					}
					return { type: 'input_text', text: JSON.stringify(b) }
				})
				input.push({ role: 'user', content: parts })
			} else {
				input.push({ role: 'user', content: [{ type: 'input_text', text: msg.content }] })
			}
		} else if (msg.role === 'assistant' && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block.type === 'text') {
					input.push({
						type: 'message', role: 'assistant', status: 'completed',
						content: [{ type: 'output_text', text: block.text, annotations: [] }],
					})
				} else if (block.type === 'thinking') {
					const signature = parseReasoningSignature(block.signature ?? block.thinkingSignature)
					if (signature) input.push(signature)
				} else if (block.type === 'tool_use') {
					input.push({
						type: 'function_call',
						call_id: block.id,
						name: block.name,
						arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input),
					})
				}
			}
		}
	}
	return input
}

function parseReasoningSignature(signature: unknown): any | null {
	if (typeof signature !== 'string' || !signature.trim()) return null
	try {
		const parsed = JSON.parse(signature)
		if (parsed?.type !== 'reasoning') return null
		if (typeof parsed.encrypted_content !== 'string' || !parsed.encrypted_content) return null
		return parsed
	} catch {
		return null
	}
}

function convertTools(tools: any[]): any[] {
	return tools
		.filter((t: any) => !t.type || t.type === 'custom')
		.map((t: any) => ({
			type: 'function',
			name: t.name,
			description: t.description,
			parameters: t.input_schema,
		}))
}

// ── SSE parsing ──

interface StreamState {
	itemMap: Map<number, { type: string; id?: string; name?: string }>
	toolInputs: Map<number, string>
}

function parseSSEEvents(state: StreamState, event: any): ProviderEvent[] {
	const type = event.type
	if (!type) return []

	if (type === 'response.output_item.added') {
		const item = event.item
		const oi = event.output_index ?? 0
		if (item.type === 'reasoning') {
			state.itemMap.set(oi, { type: 'reasoning' })
		} else if (item.type === 'message') {
			state.itemMap.set(oi, { type: 'message' })
		} else if (item.type === 'function_call') {
			state.itemMap.set(oi, { type: 'function_call', id: item.call_id, name: item.name })
			state.toolInputs.set(oi, '')
		}
		return []
	}

	if (type === 'response.reasoning_summary_text.delta') {
		return [{ type: 'thinking', text: event.delta ?? '' }]
	}

	if (type === 'response.reasoning_summary_part.done') {
		return [{ type: 'thinking', text: '\n\n' }]
	}

	if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
		return [{ type: 'text', text: event.delta ?? '' }]
	}

	if (type === 'response.function_call_arguments.delta') {
		const oi = event.output_index ?? 0
		const cur = state.toolInputs.get(oi) ?? ''
		state.toolInputs.set(oi, cur + (event.delta ?? ''))
		return []
	}

	if (type === 'response.function_call_arguments.done') {
		const oi = event.output_index ?? 0
		if (typeof event.arguments === 'string') state.toolInputs.set(oi, event.arguments)
		return []
	}

	if (type === 'response.output_item.done') {
		const oi = event.output_index ?? 0
		const info = state.itemMap.get(oi)
		if (info?.type === 'reasoning') {
			const item = event.item
			if (item?.type === 'reasoning' && typeof item.encrypted_content === 'string' && item.encrypted_content) {
				return [{ type: 'thinking_signature', signature: JSON.stringify(item) }]
			}
			return []
		}
		if (info?.type === 'function_call') {
			const json = state.toolInputs.get(oi) ?? event.item?.arguments ?? '{}'
			let input: unknown = {}
			try { input = JSON.parse(json) } catch {}
			return [{ type: 'tool_call', id: info.id ?? `call_${oi}`, name: info.name ?? '', input }]
		}
		return []
	}

	if (type === 'response.completed') {
		const response = event.response
		const events: ProviderEvent[] = []
		if (response?.status === 'failed' || response?.status === 'cancelled') {
			const detail = response?.status_details?.error?.message
				?? response?.status_details?.message
				?? response?.status
			events.push({ type: 'error', message: `Response ${response.status}`, body: String(detail) })
		}
		const usage = response?.usage
		if (usage) {
			const cached = usage.input_tokens_details?.cached_tokens ?? 0
			events.push({ type: 'done', usage: { input: (usage.input_tokens ?? 0) - cached + cached, output: usage.output_tokens ?? 0 } })
		} else {
			events.push({ type: 'done' })
		}
		return events
	}

	if (type === 'error') {
		const message = event.error?.message ?? event.message ?? 'Unknown error'
		const body = JSON.stringify(event.error ?? event)
		return [{ type: 'error', message, body }]
	}

	if (type === 'response.failed') {
		const message = event.error?.message ?? 'Response failed'
		const body = JSON.stringify(event)
		return [{ type: 'error', message, body }]
	}

	return []
}

// ── Provider ──

async function* generate(params: GenerateParams): AsyncGenerator<ProviderEvent> {
	await refreshOpenAIAuth()
	const { accessToken, accountId: storedAccountId } = getAuth('openai')
	if (!accessToken) {
		yield { type: 'error', message: 'No OpenAI credentials. Add openai.accessToken to auth.ason.' }
		yield { type: 'done' }
		return
	}

	const token = accessToken
	const codex = openaiUsesCodex(token)
	const apiUrl = resolveApiUrl(token)

	const input = convertMessages(params.messages)
	const openaiTools = convertTools(params.tools ?? [])
	const instructions = params.systemPrompt

	const body: any = { model: params.model, store: false, stream: true, input }
	if (instructions) body.instructions = instructions

	if (!codex) {
		body.max_output_tokens = params.model.includes('codex') ? 128_000 : 16_384
	} else {
		body.text = { verbosity: 'high' }
		body.include = ['reasoning.encrypted_content']
		if (params.sessionId) body.prompt_cache_key = params.sessionId
	}

	if (openaiTools.length > 0) {
		body.tools = openaiTools
		body.tool_choice = 'auto'
		body.parallel_tool_calls = true
	}

	// Reasoning: xhigh for codex, high for other capable models
	if (params.model.includes('codex')) {
		body.reasoning = { effort: 'xhigh', summary: 'auto' }
	} else if (params.model.startsWith('o') || params.model.startsWith('gpt-5.4')) {
		body.reasoning = { effort: 'high', summary: 'auto' }
	}

	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
		Authorization: `Bearer ${token}`,
		accept: 'text/event-stream',
	}
	if (codex) {
		const accountId = extractOpenAIAccountId(token) || storedAccountId || ''
		if (!accountId) {
			yield { type: 'error', message: 'OpenAI token missing chatgpt_account_id' }
			yield { type: 'done' }
			return
		}
		headers['OpenAI-Beta'] = 'responses=experimental'
		headers.originator = 'pi'
		headers['chatgpt-account-id'] = accountId
	}

	const res = await fetch(apiUrl, {
		method: 'POST', headers,
		body: JSON.stringify(body),
		signal: params.signal,
	})

	if (!res.ok) {
		const body = (await res.text()).slice(0, 2000)
		yield { type: 'error', message: `API ${res.status}`, status: res.status, body }
		yield { type: 'done' }
		return
	}

	yield* parseStream(res.body!)
}

async function* parseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<ProviderEvent> {
	const reader = body.getReader()
	const decoder = new TextDecoder()
	let buf = ''
	let gotDone = false
	const state: StreamState = { itemMap: new Map(), toolInputs: new Map() }

	while (true) {
		const { done, value } = await readWithTimeout(reader)
		if (done) break
		buf += decoder.decode(value, { stream: true })

		let nl: number
		while ((nl = buf.indexOf('\n')) !== -1) {
			const line = buf.slice(0, nl).trimEnd()
			buf = buf.slice(nl + 1)
			if (!line.startsWith('data: ')) continue

			let ev: any
			try { ev = JSON.parse(line.slice(6)) } catch { continue }

			for (const event of parseSSEEvents(state, ev)) {
				yield event
				if (event.type === 'done') gotDone = true
			}
		}
	}

	if (!gotDone) yield { type: 'done' }
}

const provider: Provider = { name: 'openai', generate }
export default provider
