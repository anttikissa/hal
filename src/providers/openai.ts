// OpenAI + compat provider.
//
// Native OpenAI uses the Responses API. When the credential is a ChatGPT OAuth
// token without direct API scopes, requests must go through the Codex backend
// on chatgpt.com instead of api.openai.com.
//
// OpenAI-compatible providers (OpenRouter, Google, Grok, Ollama, etc.) still
// use the Chat Completions API because that is the broadest common denominator.

import type { Message, Provider, ProviderRequest, ProviderStreamEvent } from '../protocol.ts'
import { auth, type Credential } from '../auth.ts'
import { provider as providerUtils } from './provider.ts'
import { openaiUsage } from '../openai-usage.ts'
import { reasoningSignature } from '../session/reasoning-signature.ts'
import { models } from '../models.ts'

// ── Endpoint configuration ──

const RESPONSES_API_URL = 'https://api.openai.com/v1/responses'
const CODEX_BASE_URL = 'https://chatgpt.com/backend-api'

const COMPAT_ENDPOINTS: Record<string, string> = {
	openrouter: 'https://openrouter.ai/api/v1',
	google: 'https://generativelanguage.googleapis.com/v1beta/openai',
	grok: 'https://api.x.ai/v1',
}


function getCredential(providerName: string): Credential | undefined {
	return auth.getCredential(providerName)
}

// ── OpenAI OAuth token helpers ──

function decodeJwtPayload(token: string): any | null {
	try {
		const parts = token.split('.')
		if (parts.length !== 3) return null
		return JSON.parse(atob(parts[1]!))
	} catch {
		return null
	}
}

function hasOpenAIScope(token: string, scope: string): boolean {
	const payload = decodeJwtPayload(token)
	if (!payload) return false

	for (const claim of [payload.scp, payload.scope]) {
		if (Array.isArray(claim) && claim.includes(scope)) return true
		if (typeof claim === 'string' && claim.split(/\s+/).includes(scope)) return true
	}

	return false
}

function extractOpenAIAccountId(token: string): string | null {
	const payload = decodeJwtPayload(token)
	const id = payload?.['https://api.openai.com/auth']?.chatgpt_account_id
	return typeof id === 'string' && id.length > 0 ? id : null
}

function openaiUsesCodexBackend(credential: Credential): boolean {
	if (credential.type === 'api-key') return false
	return !hasOpenAIScope(credential.value, 'api.responses.write')
}

function resolveOpenAIApiUrl(credential: Credential): string {
	if (openaiUsesCodexBackend(credential)) return `${CODEX_BASE_URL}/codex/responses`
	return RESPONSES_API_URL
}

function parseResetsInSeconds(body: string | undefined): number | undefined {
	if (!body) return undefined
	try {
		const json = JSON.parse(body)
		const secs = json?.error?.resets_in_seconds ?? json?.resets_in_seconds
		if (typeof secs === 'number' && secs > 0) return secs * 1000
	} catch {}
	return undefined
}

function formatAccountLabel(credential: Credential): string {
	if (credential.email) return credential.email
	if (credential.total && credential.index != null) return `account ${credential.index + 1}/${credential.total}`
	return 'current account'
}

function formatRotationActivity(credential: Credential): string | undefined {
	if (!credential.total || credential.total < 2 || credential.index == null) return undefined
	return `OpenAI ${credential.index + 1}/${credential.total} · ${formatAccountLabel(credential)}`
}

function formatRotationMessage(current: Credential, next: Credential | undefined, retryAfterMs: number, fast: boolean): string {
	const total = current.total ?? 1
	const currentLabel = formatAccountLabel(current)
	const nextLabel = next ? formatAccountLabel(next) : 'the next available account'
	if (fast) return `OpenAI rotation: ${total} accounts. 429 on ${currentLabel}. Trying ${nextLabel} next.`
	return `OpenAI rotation: ${total} accounts. 429 on ${currentLabel}. All accounts cooling down. Next: ${nextLabel} in ${Math.ceil(retryAfterMs / 1000)}s.`
}

// ── Responses API message conversion ──
// Our internal message format follows Anthropic's structure. Native OpenAI
// expects Responses API items instead.

function formatForeignThinkingForOpenAI(thinking: unknown, sourceModel: unknown): string | null {
	if (typeof thinking !== 'string') return null
	const text = thinking.trim()
	if (!text) return null
	const model = typeof sourceModel === 'string' && sourceModel ? sourceModel : 'unknown'
	return `[model ${model} thinking]\n${text}`
}

function convertResponsesMessages(messages: Message[]): any[] {
	const input: any[] = []
	const seenReasoningIds = new Set<string>()

	for (const msg of messages) {
		if (msg.role === 'user') {
			if (!Array.isArray(msg.content)) {
				input.push({ role: 'user', content: [{ type: 'input_text', text: msg.content }] })
				continue
			}

			const toolResults = msg.content.filter((block: any) => block.type === 'tool_result')
			const others = msg.content.filter((block: any) => block.type !== 'tool_result')

			for (const tr of toolResults) {
				input.push({
					type: 'function_call_output',
					call_id: tr.tool_use_id,
					output: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content),
				})
			}

			if (others.length === 0) continue

			const parts = others.map((block: any) => {
				if (block.type === 'text') return { type: 'input_text', text: block.text }
				if (block.type === 'image') {
					const src = block.source
					return {
						type: 'input_image',
						detail: 'auto',
						image_url: `data:${src?.media_type ?? 'image/png'};base64,${src?.data ?? block.data}`,
					}
				}
				return { type: 'input_text', text: JSON.stringify(block) }
			})

			input.push({ role: 'user', content: parts })
			continue
		}

		if (msg.role !== 'assistant') continue

		if (!Array.isArray(msg.content)) {
			input.push({
				type: 'message',
				role: 'assistant',
				status: 'completed',
				content: [{ type: 'output_text', text: msg.content, annotations: [] }],
			})
			continue
		}

		for (const block of msg.content) {
			if (block.type === 'text') {
				input.push({
					type: 'message',
					role: 'assistant',
					status: 'completed',
					content: [{ type: 'output_text', text: block.text, annotations: [] }],
				})
				continue
			}

			if (block.type === 'thinking') {
				// Codex backend rejects replayed reasoning items that omit `summary`.
				// Older sessions may have compacted signatures without it, so rebuild
				// the summary from the stored thinking text when needed.
				const signature = reasoningSignature.withSummary(
					block.signature ?? (block as any).thinkingSignature,
					block.thinking,
				)
				if (signature && (!signature.id || !seenReasoningIds.has(signature.id))) {
					if (signature.id) seenReasoningIds.add(signature.id)
					input.push(signature)
					continue
				}

				const replayed = formatForeignThinkingForOpenAI(block.thinking, (block as any)._model)
				if (replayed) {
					input.push({
						type: 'message',
						role: 'assistant',
						status: 'completed',
						content: [{ type: 'output_text', text: replayed, annotations: [] }],
					})
				}
				continue
			}

			if (block.type === 'tool_use') {
				input.push({
					type: 'function_call',
					call_id: block.id,
					name: block.name,
					arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input),
				})
			}
		}
	}

	return input
}

function convertResponsesTools(tools: any[]): any[] {
	return tools.map((tool) => ({
		type: 'function',
		name: tool.name,
		description: tool.description,
		parameters: tool.input_schema ?? tool.parameters,
	}))
}

// ── Chat Completions message conversion ──
// Compat endpoints expect OpenAI Chat Completions messages instead.

function convertCompatMessages(messages: Message[]): any[] {
	const out: any[] = []

	for (const msg of messages) {
		if (msg.role === 'user') {
			if (typeof msg.content === 'string') {
				out.push({ role: 'user', content: msg.content })
				continue
			}

			const toolResults = msg.content.filter((block: any) => block.type === 'tool_result')
			const others = msg.content.filter((block: any) => block.type !== 'tool_result')

			for (const tr of toolResults) {
				out.push({
					role: 'tool',
					tool_call_id: tr.tool_use_id,
					content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content),
				})
			}

			if (others.length === 0) continue

			const parts: any[] = []
			for (const block of others) {
				if (block.type === 'text') {
					parts.push({ type: 'text', text: block.text })
				} else if (block.type === 'image') {
					const src = (block as any).source
					if (src?.type === 'base64') {
						parts.push({
							type: 'image_url',
							image_url: { url: `data:${src.media_type};base64,${src.data}` },
						})
					}
				}
			}

			if (parts.length === 1 && parts[0]!.type === 'text') {
				out.push({ role: 'user', content: parts[0]!.text })
			} else if (parts.length > 0) {
				out.push({ role: 'user', content: parts })
			}
			continue
		}

		if (msg.role !== 'assistant') continue

		if (typeof msg.content === 'string') {
			out.push({ role: 'assistant', content: msg.content })
			continue
		}

		let text = ''
		const toolCalls: any[] = []

		for (const block of msg.content) {
			if (block.type === 'text') text += block.text
			else if (block.type === 'tool_use') {
				toolCalls.push({
					id: block.id,
					type: 'function',
					function: { name: block.name, arguments: JSON.stringify(block.input) },
				})
			}
			// Thinking blocks are skipped: Chat Completions has no equivalent.
		}

		const message: any = { role: 'assistant' }
		if (text) message.content = text
		if (toolCalls.length) message.tool_calls = toolCalls
		if (!text && !toolCalls.length) message.content = ''
		out.push(message)
	}

	return out
}

function convertCompatTools(tools: any[]): any[] {
	return tools.map((tool) => ({
		type: 'function',
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.input_schema ?? tool.parameters,
		},
	}))
}

// ── Responses SSE parser ──

interface ResponsesStreamState {
	itemMap: Map<number, { type: string; id?: string; name?: string }>
	toolInputs: Map<number, string>
}

function parseResponsesEvent(state: ResponsesStreamState, event: any): ProviderStreamEvent[] {
	const type = event.type
	if (!type) return []

	if (type === 'response.output_item.added') {
		const item = event.item
		const outputIndex = event.output_index ?? 0

		if (item?.type === 'reasoning') {
			state.itemMap.set(outputIndex, { type: 'reasoning' })
		} else if (item?.type === 'message') {
			state.itemMap.set(outputIndex, { type: 'message' })
		} else if (item?.type === 'function_call') {
			state.itemMap.set(outputIndex, { type: 'function_call', id: item.call_id, name: item.name })
			state.toolInputs.set(outputIndex, '')
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
		const outputIndex = event.output_index ?? 0
		const current = state.toolInputs.get(outputIndex) ?? ''
		state.toolInputs.set(outputIndex, current + (event.delta ?? ''))
		return []
	}

	if (type === 'response.function_call_arguments.done') {
		const outputIndex = event.output_index ?? 0
		if (typeof event.arguments === 'string') state.toolInputs.set(outputIndex, event.arguments)
		return []
	}

	if (type === 'response.output_item.done') {
		const outputIndex = event.output_index ?? 0
		const info = state.itemMap.get(outputIndex)

		if (info?.type === 'reasoning') {
			const signature = reasoningSignature.minimize(event.item)
			if (signature) return [{ type: 'thinking_signature', signature }]
			return []
		}

		if (info?.type === 'function_call') {
			const json = state.toolInputs.get(outputIndex) ?? event.item?.arguments ?? '{}'
			try {
				return [{
					type: 'tool_call',
					id: info.id ?? `call_${outputIndex}`,
					name: info.name ?? '',
					input: JSON.parse(json),
				}]
			} catch {
				return [{
					type: 'tool_call',
					id: info.id ?? `call_${outputIndex}`,
					name: info.name ?? '',
					input: {},
					parseError: `Failed to parse tool input JSON (${json.length} chars): ${json.slice(0, 200)}`,
				}]
			}
		}

		return []
	}

	if (type === 'response.completed') {
		const response = event.response
		const events: ProviderStreamEvent[] = []

		if (response?.status === 'failed' || response?.status === 'cancelled') {
			const detail =
				response?.status_details?.error?.message ??
				response?.status_details?.message ??
				response?.status
			events.push({
				type: 'error',
				message: `Response ${response.status}`,
				body: String(detail),
			})
		}

		const usage = response?.usage
		if (usage) {
			// OpenAI Responses API reports cached prompt tokens under input_tokens_details.cached_tokens.
			// input_tokens is the total (cached + uncached), so subtract to get the uncached portion.
			const cacheRead = usage.input_tokens_details?.cached_tokens ?? 0
			const totalInput = usage.input_tokens ?? 0
			events.push({
				type: 'done',
				usage: {
					input: Math.max(0, totalInput - cacheRead),
					output: usage.output_tokens ?? 0,
					cacheRead,
					cacheCreation: 0,
				},
			})
		} else {
			events.push({ type: 'done' })
		}

		return events
	}

	if (type === 'error') {
		return [{
			type: 'error',
			message: event.error?.message ?? event.message ?? 'Unknown error',
			body: JSON.stringify(event.error ?? event),
		}]
	}

	if (type === 'response.failed') {
		return [{
			type: 'error',
			message: event.error?.message ?? 'Response failed',
			body: JSON.stringify(event),
		}]
	}

	return []
}

async function* parseResponsesStream(body: ReadableStream<Uint8Array>): AsyncGenerator<ProviderStreamEvent> {
	const reader = body.getReader() as ReadableStreamDefaultReader<Uint8Array>
	const decoder = new TextDecoder()
	let buf = ''
	let gotDone = false
	const state: ResponsesStreamState = {
		itemMap: new Map(),
		toolInputs: new Map(),
	}

	try {
		while (true) {
			const { done, value } = await providerUtils.readWithTimeout(reader)
			if (done) break
			buf += decoder.decode(value, { stream: true })

			let nl: number
			while ((nl = buf.indexOf('\n')) !== -1) {
				const line = buf.slice(0, nl).trimEnd()
				buf = buf.slice(nl + 1)
				if (!line.startsWith('data: ')) continue

				let event: any
				try {
					event = JSON.parse(line.slice(6))
				} catch {
					continue
				}

				for (const parsed of parseResponsesEvent(state, event)) {
					yield parsed
					if (parsed.type === 'done') gotDone = true
				}
			}
		}
	} finally {
		reader.releaseLock()
	}

	if (!gotDone) yield { type: 'done' }
}

// ── Chat Completions SSE parser ──
// Compat endpoints all stream with the Chat Completions event format.

async function* parseChatCompletionsStream(body: ReadableStream<Uint8Array>): AsyncGenerator<ProviderStreamEvent> {
	const reader = body.getReader() as ReadableStreamDefaultReader<Uint8Array>
	const decoder = new TextDecoder()
	let buf = ''
	let inputTokens = 0
	let outputTokens = 0

	// Tool calls are streamed incrementally across multiple chunks.
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
				try {
					chunk = JSON.parse(data)
				} catch {
					continue
				}

				const choice = chunk.choices?.[0]
				if (!choice) {
					// Some providers send usage in a separate final chunk.
					if (chunk.usage) {
						inputTokens = chunk.usage.prompt_tokens ?? 0
						outputTokens = chunk.usage.completion_tokens ?? 0
					}
					continue
				}

				const delta = choice.delta
				if (delta?.content) yield { type: 'text', text: delta.content }

				if (delta?.tool_calls) {
					for (const tc of delta.tool_calls) {
						const index = tc.index ?? 0
						if (tc.id) {
							toolCalls.set(index, { id: tc.id, name: tc.function?.name ?? '', args: '' })
						}
						const entry = toolCalls.get(index)
						if (!entry) continue
						if (tc.function?.name) entry.name = tc.function.name
						if (tc.function?.arguments) entry.args += tc.function.arguments
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

	for (const [, toolCall] of toolCalls) {
		try {
			yield {
				type: 'tool_call',
				id: toolCall.id,
				name: toolCall.name,
				input: JSON.parse(toolCall.args),
			}
		} catch {
			yield {
				type: 'tool_call',
				id: toolCall.id,
				name: toolCall.name,
				input: {},
				parseError: `Failed to parse tool input JSON (${toolCall.args.length} chars): ${toolCall.args.slice(0, 200)}`,
			}
		}
	}

	yield {
		type: 'done',
		usage:
			inputTokens || outputTokens
				? { input: inputTokens, output: outputTokens, cacheRead: 0, cacheCreation: 0 }
				: undefined,
	}
}

// ── Compat provider implementation ──

async function* generateCompat(
	providerName: string,
	baseUrl: string,
	req: ProviderRequest,
): AsyncGenerator<ProviderStreamEvent> {
	await auth.ensureFresh(providerName)
	const credential = getCredential(providerName)
	if (!credential) {
		yield {
			type: 'error',
			message: `No credentials for '${providerName}'. Run: bun scripts/login-openai.ts (or set ${providerName.toUpperCase()}_API_KEY)`,
		}
		yield { type: 'done' }
		return
	}

	const body: any = {
		model: req.model,
		messages: [{ role: 'system', content: req.systemPrompt }, ...convertCompatMessages(req.messages)],
		stream: true,
	}
	if (req.tools?.length) body.tools = convertCompatTools(req.tools)

	const endpoint = `${baseUrl}/chat/completions`
	const res = await fetch(endpoint, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${credential.value}`,
		},
		body: JSON.stringify(body),
		signal: req.signal,
	})

	if (!res.ok) {
		const text = (await res.text()).slice(0, 2000)
		yield {
			type: 'error',
			message: `${providerName} ${res.status}: ${res.statusText}`,
			status: res.status,
			body: text,
			endpoint,
			retryAfterMs: providerUtils.parseRetryDelay(res, text),
		}
		yield { type: 'done' }
		return
	}

for await (const event of parseChatCompletionsStream(res.body!)) {
		if (event.type === 'done' && event.usage && credential.type === 'token') openaiUsage.recordUsage(credential, event.usage)
		yield event
	}
}

// ── Native OpenAI provider implementation ──

async function* generateOpenAI(req: ProviderRequest): AsyncGenerator<ProviderStreamEvent> {
	await auth.ensureFresh('openai')
	const credential = getCredential('openai')
	if (!credential) {
		// Check if all accounts are rate-limited vs no accounts at all
		const exhaustedMsg = auth.allOnCooldownMessage('openai')
		yield {
			type: 'error',
			message: exhaustedMsg ?? `No credentials for 'openai'. Run: bun scripts/login-openai.ts (or set OPENAI_API_KEY)`,
		}
		yield { type: 'done' }
		return
	}

	const usesCodexBackend = openaiUsesCodexBackend(credential)
	const apiUrl = resolveOpenAIApiUrl(credential)
	const openaiEntry = auth.getEntry('openai')

	const body: any = {
		model: req.model,
		store: false,
		stream: true,
		input: convertResponsesMessages(req.messages),
	}
	if (req.systemPrompt) body.instructions = req.systemPrompt

	if (!usesCodexBackend) {
		body.max_output_tokens = req.model.includes('codex') ? 128_000 : 16_384
	} else {
		// Codex backend exposes extra reasoning features and prompt cache keys.
		body.text = { verbosity: 'high' }
		body.include = ['reasoning.encrypted_content']
		if (req.sessionId) body.prompt_cache_key = req.sessionId
	}

	if (req.tools?.length) {
		body.tools = convertResponsesTools(req.tools)
		body.tool_choice = 'auto'
		body.parallel_tool_calls = true
	}

	const effort = models.reasoningEffort(req.model)
	if (effort) body.reasoning = { effort, summary: 'auto' }

	openaiUsage.setCurrentCredential(credential)
	const rotationActivity = formatRotationActivity(credential)
	if (rotationActivity) yield { type: 'status', activity: rotationActivity }

	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
		Authorization: `Bearer ${credential.value}`,
		accept: 'text/event-stream',
	}

	if (usesCodexBackend) {
		const accountId = extractOpenAIAccountId(credential.value) || openaiEntry.accountId || ''
		if (!accountId) {
			yield {
				type: 'error',
				message: 'OpenAI token missing chatgpt_account_id',
			}
			yield { type: 'done' }
			return
		}

		headers['OpenAI-Beta'] = 'responses=experimental'
		headers.originator = 'pi'
		headers['chatgpt-account-id'] = accountId
	}

	const res = await fetch(apiUrl, {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
		signal: req.signal,
	})

	if (!res.ok) {
		const text = (await res.text()).slice(0, 2000)
		const retryAfterMs = providerUtils.parseRetryDelay(res, text)
		// Mark this credential on cooldown so the next retry picks a different account.
		// Default cooldown: 10 minutes, or whatever the server says via Retry-After.
		if (res.status === 429) {
			const bodyResetMs = parseResetsInSeconds(text)
			const cooldownMs = bodyResetMs ?? retryAfterMs ?? 10 * 60_000
			auth.markCooldown(credential, cooldownMs)
			// Retry fast only if another account is available.
			// Otherwise use the body's reset time so we don't spin forever.
			const fast = auth.hasAvailableCredential('openai')
			const nextCredential = getCredential('openai')
			yield {
				type: 'error',
				message: formatRotationMessage(credential, nextCredential, fast ? 1_000 : cooldownMs, fast),
				status: res.status,
				body: text,
				endpoint: apiUrl,
				retryAfterMs: fast ? 1_000 : cooldownMs,
			}
		} else {
			yield {
				type: 'error',
				message: `openai ${res.status}: ${res.statusText}`,
				status: res.status,
				body: text,
				endpoint: apiUrl,
				retryAfterMs,
			}
		}
		yield { type: 'done' }
		return
	}

for await (const event of parseResponsesStream(res.body!)) {
		if (event.type === 'done' && event.usage) openaiUsage.recordUsage(credential, event.usage)
		yield event
	}
}

// ── Exports ──

export const openaiProvider: Provider = { generate: generateOpenAI }

/** Create a Chat Completions-compatible provider for any OpenAI-like endpoint. */
export function createCompatProvider(providerName: string, baseUrl?: string): Provider {
	const url = baseUrl ?? COMPAT_ENDPOINTS[providerName]
	if (!url) {
		throw new Error(
			`Unknown compat provider '${providerName}'. ` +
				`Known endpoints: ${Object.keys(COMPAT_ENDPOINTS).join(', ')}. ` +
				`Or pass a custom baseUrl.`,
		)
	}

	return {
		generate: (req) => generateCompat(providerName, url, req),
	}
}

export const openai = {
	openaiProvider,
	createCompatProvider,
	convertResponsesMessages,
	convertResponsesTools,
	convertCompatMessages,
	convertCompatTools,
	resolveOpenAIApiUrl,
	openaiUsesCodexBackend,
	extractOpenAIAccountId,
	COMPAT_ENDPOINTS,
}
