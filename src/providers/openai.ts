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
import { providerShared } from './shared.ts'
import { openaiUsage } from '../openai-usage.ts'
import { reasoningSignature } from '../session/reasoning-signature.ts'
import { models } from '../models.ts'

const RESPONSES_API_URL = 'https://api.openai.com/v1/responses'
const CODEX_BASE_URL = 'https://chatgpt.com/backend-api'

function inspectOpenAIToken(token: string): { accountId: string | null; hasResponsesScope: boolean } {
	try {
		const payload = JSON.parse(atob(token.split('.')[1]!))
		const accountId = payload?.['https://api.openai.com/auth']?.chatgpt_account_id
		const hasResponsesScope = [payload?.scp, payload?.scope].some((claim) =>
			Array.isArray(claim) ? claim.includes('api.responses.write') : typeof claim === 'string' && claim.split(/\s+/).includes('api.responses.write'),
		)
		return { accountId: typeof accountId === 'string' && accountId ? accountId : null, hasResponsesScope }
	} catch {
		return { accountId: null, hasResponsesScope: false }
	}
}

function resolveOpenAITransport(credential: Credential): { apiUrl: string; usesCodexBackend: boolean; accountId: string | null } {
	if (credential.type === 'api-key') return { apiUrl: RESPONSES_API_URL, usesCodexBackend: false, accountId: null }
	const token = inspectOpenAIToken(credential.value)
	return {
		apiUrl: token.hasResponsesScope ? RESPONSES_API_URL : `${CODEX_BASE_URL}/codex/responses`,
		usesCodexBackend: !token.hasResponsesScope,
		accountId: token.accountId,
	}
}

function parseResetsInSeconds(body: string | undefined): number | undefined {
	if (!body) return
	try {
		const json = JSON.parse(body)
		const secs = json?.error?.resets_in_seconds ?? json?.resets_in_seconds
		if (typeof secs === 'number' && secs > 0) return secs * 1000
	} catch {}
}

function formatForeignThinkingForOpenAI(thinking: unknown, sourceModel: unknown): string | null {
	if (typeof thinking !== 'string') return null
	const text = thinking.trim()
	if (!text) return null
	const model = typeof sourceModel === 'string' && sourceModel ? sourceModel : 'unknown'
	return `[model ${model} thinking]\n${text}`
}

function assistantOutputText(text: string): any {
	return { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }
}

function stringifyToolContent(content: unknown): string {
	return typeof content === 'string' ? content : JSON.stringify(content)
}

function splitUserBlocks(blocks: any[]): { toolResults: any[]; others: any[] } {
	const toolResults: any[] = []
	const others: any[] = []
	for (const block of blocks) block.type === 'tool_result' ? toolResults.push(block) : others.push(block)
	return { toolResults, others }
}

function imageDataUrl(block: any): string {
	const src = block.source
	return `data:${src?.media_type ?? 'image/png'};base64,${src?.data ?? block.data}`
}

function normalizeTool(tool: any): { name: string; description: string; parameters: any } {
	return { name: tool.name, description: tool.description, parameters: tool.input_schema ?? tool.parameters }
}

function convertResponsesUserPart(block: any): any {
	if (block.type === 'text') return { type: 'input_text', text: block.text ?? '' }
	if (block.type === 'image') return { type: 'input_image', detail: 'auto', image_url: imageDataUrl(block) }
	return { type: 'input_text', text: JSON.stringify(block) }
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
			const { toolResults, others } = splitUserBlocks(msg.content)
			for (const tr of toolResults) input.push({ type: 'function_call_output', call_id: tr.tool_use_id, output: stringifyToolContent(tr.content) })
			if (others.length > 0) input.push({ role: 'user', content: others.map(convertResponsesUserPart) })
			continue
		}
		if (msg.role !== 'assistant') continue
		if (!Array.isArray(msg.content)) {
			input.push(assistantOutputText(msg.content))
			continue
		}
		for (const block of msg.content) {
			if (block.type === 'text') {
				input.push(assistantOutputText(block.text ?? ''))
				continue
			}
			if (block.type === 'thinking') {
				// Codex backend rejects replayed reasoning items that omit `summary`.
				// Older sessions may have compacted signatures without it, so rebuild
				// the summary from the stored thinking text when needed.
				const signature = reasoningSignature.withSummary(block.signature ?? (block as any).thinkingSignature, block.thinking)
				if (signature && (!signature.id || !seenReasoningIds.has(signature.id))) {
					if (signature.id) seenReasoningIds.add(signature.id)
					input.push(signature)
					continue
				}
				const replayed = formatForeignThinkingForOpenAI(block.thinking, (block as any)._model)
				if (replayed) input.push(assistantOutputText(replayed))
				continue
			}
			if (block.type === 'tool_use') {
				input.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: stringifyToolContent(block.input) })
			}
		}
	}
	return input
}

function convertResponsesTools(tools: any[]): any[] {
	return tools.map((tool) => ({ type: 'function', ...normalizeTool(tool) }))
}

function convertCompatMessages(messages: Message[]): any[] {
	const out: any[] = []
	for (const msg of messages) {
		if (msg.role === 'user') {
			if (typeof msg.content === 'string') {
				out.push({ role: 'user', content: msg.content })
				continue
			}
			const { toolResults, others } = splitUserBlocks(msg.content)
			for (const tr of toolResults) out.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: stringifyToolContent(tr.content) })
			if (others.length === 0) continue
			const parts: any[] = []
			for (const block of others) {
				if (block.type === 'text') parts.push({ type: 'text', text: block.text })
				else if (block.type === 'image' && block.source?.type === 'base64') parts.push({ type: 'image_url', image_url: { url: imageDataUrl(block) } })
			}
			if (parts.length === 1 && parts[0]!.type === 'text') out.push({ role: 'user', content: parts[0]!.text })
			else if (parts.length > 0) out.push({ role: 'user', content: parts })
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
			else if (block.type === 'tool_use') toolCalls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input) } })
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
	return tools.map((tool) => ({ type: 'function', function: normalizeTool(tool) }))
}

interface ResponsesStreamState {
	itemMap: Map<number, { type: 'reasoning' } | { type: 'function_call'; id?: string; name?: string }>
	toolInputs: Map<number, string>
}

function parseResponsesEvent(state: ResponsesStreamState, event: any): ProviderStreamEvent[] {
	const type = event.type
	if (!type) return []
	if (type === 'response.output_item.added') {
		const item = event.item
		const outputIndex = event.output_index ?? 0
		if (item?.type === 'reasoning') state.itemMap.set(outputIndex, { type: 'reasoning' })
		else if (item?.type === 'function_call') {
			state.itemMap.set(outputIndex, { type: 'function_call', id: item.call_id, name: item.name })
			state.toolInputs.set(outputIndex, '')
		}
		return []
	}
	if (type === 'response.reasoning_summary_text.delta') return [{ type: 'thinking', text: event.delta ?? '' }]
	if (type === 'response.reasoning_summary_part.done') return [{ type: 'thinking', text: '\n\n' }]
	if (type === 'response.output_text.delta' || type === 'response.refusal.delta') return [{ type: 'text', text: event.delta ?? '' }]
	if (type === 'response.function_call_arguments.delta') {
		const outputIndex = event.output_index ?? 0
		state.toolInputs.set(outputIndex, (state.toolInputs.get(outputIndex) ?? '') + (event.delta ?? ''))
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
			return signature ? [{ type: 'thinking_signature', signature }] : []
		}
		if (info?.type === 'function_call') {
			const parsed = providerShared.parseToolInput(state.toolInputs.get(outputIndex) ?? event.item?.arguments ?? '{}')
			return [{ type: 'tool_call', id: info.id ?? `call_${outputIndex}`, name: info.name ?? '', input: parsed.input, ...(parsed.parseError ? { parseError: parsed.parseError } : {}) }]
		}
		return []
	}
	if (type === 'response.completed') {
		const response = event.response
		const events: ProviderStreamEvent[] = []
		if (response?.status === 'failed' || response?.status === 'cancelled') {
			const detail = response?.status_details?.error?.message ?? response?.status_details?.message ?? response?.status
			events.push({ type: 'error', message: `Response ${response.status}`, body: String(detail) })
		}
		const usage = response?.usage
		if (!usage) return [...events, { type: 'done' }]
		const cacheRead = usage.input_tokens_details?.cached_tokens ?? 0
		const totalInput = usage.input_tokens ?? 0
		events.push({
			type: 'done',
			usage: { input: Math.max(0, totalInput - cacheRead), output: usage.output_tokens ?? 0, cacheRead, cacheCreation: 0 },
		})
		return events
	}
	if (type === 'error') return [{ type: 'error', message: event.error?.message ?? event.message ?? 'Unknown error', body: JSON.stringify(event.error ?? event) }]
	if (type === 'response.failed') return [{ type: 'error', message: event.error?.message ?? 'Response failed', body: JSON.stringify(event) }]
	return []
}

async function* parseResponsesStream(body: ReadableStream<Uint8Array>): AsyncGenerator<ProviderStreamEvent> {
	let gotDone = false
	const state: ResponsesStreamState = { itemMap: new Map(), toolInputs: new Map() }
	for await (const event of providerShared.iterateJsonSse(body)) {
		for (const parsed of parseResponsesEvent(state, event)) {
			yield parsed
			if (parsed.type === 'done') gotDone = true
		}
	}
	if (!gotDone) yield { type: 'done' }
}

async function* parseChatCompletionsStream(body: ReadableStream<Uint8Array>): AsyncGenerator<ProviderStreamEvent> {
	let inputTokens = 0
	let outputTokens = 0
	const toolCalls = new Map<number, { id: string; name: string; args: string }>()
	for await (const event of providerShared.iterateJsonSse(body, { trim: 'both', doneSentinel: '[DONE]' })) {
		if (event === providerShared.sseDone) continue
		const chunk: any = event
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
		if (delta?.tool_calls) {
			for (const tc of delta.tool_calls) {
				const index = tc.index ?? 0
				if (tc.id) toolCalls.set(index, { id: tc.id, name: tc.function?.name ?? '', args: '' })
				const entry = toolCalls.get(index)
				if (!entry) continue
				if (tc.function?.name) entry.name = tc.function.name
				if (tc.function?.arguments) entry.args += tc.function.arguments
			}
		}
		if ((choice.finish_reason === 'stop' || choice.finish_reason === 'tool_calls') && chunk.usage) {
			inputTokens = chunk.usage.prompt_tokens ?? 0
			outputTokens = chunk.usage.completion_tokens ?? 0
		}
	}
	for (const [, toolCall] of toolCalls) {
		const parsed = providerShared.parseToolInput(toolCall.args)
		yield { type: 'tool_call', id: toolCall.id, name: toolCall.name, input: parsed.input, ...(parsed.parseError ? { parseError: parsed.parseError } : {}) }
	}
	yield { type: 'done', usage: inputTokens || outputTokens ? { input: inputTokens, output: outputTokens, cacheRead: 0, cacheCreation: 0 } : undefined }
}

async function readErrorBody(res: Response): Promise<string> {
	return (await res.text()).slice(0, 2000)
}

async function* yieldErrorAndDone(error: ProviderStreamEvent): AsyncGenerator<ProviderStreamEvent> {
	yield error
	yield { type: 'done' }
}

async function* generateCompat(providerName: string, baseUrl: string, req: ProviderRequest): AsyncGenerator<ProviderStreamEvent> {
	await auth.ensureFresh(providerName)
	const credential = auth.getCredential(providerName)
	if (!credential) {
		yield* yieldErrorAndDone({
			type: 'error',
			message: `No credentials for '${providerName}'. Run: bun scripts/login-openai.ts (or set ${providerName.toUpperCase()}_API_KEY)`,
		})
		return
	}
	const body: any = { model: req.model, messages: [{ role: 'system', content: req.systemPrompt }, ...convertCompatMessages(req.messages)], stream: true }
	if (req.tools?.length) body.tools = convertCompatTools(req.tools)
	const endpoint = `${baseUrl}/chat/completions`
	const res = await fetch(endpoint, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credential.value}` },
		body: JSON.stringify(body),
		signal: req.signal,
	})
	if (!res.ok) {
		const text = await readErrorBody(res)
		yield* yieldErrorAndDone({ type: 'error', message: `${providerName} ${res.status}: ${res.statusText}`, status: res.status, body: text, endpoint, retryAfterMs: providerShared.parseRetryDelay(res, text) })
		return
	}
	for await (const event of parseChatCompletionsStream(res.body!)) {
		if (event.type === 'done' && event.usage && credential.type === 'token') openaiUsage.recordUsage(credential, event.usage)
		yield event
	}
}

async function* generateOpenAI(req: ProviderRequest): AsyncGenerator<ProviderStreamEvent> {
	await auth.ensureFresh('openai')
	const credential = auth.getCredential('openai')
	if (!credential) {
		yield* yieldErrorAndDone({ type: 'error', message: auth.allOnCooldownMessage('openai') ?? `No credentials for 'openai'. Run: bun scripts/login-openai.ts (or set OPENAI_API_KEY)` })
		return
	}
	const transport = resolveOpenAITransport(credential)
	const openaiEntry = auth.getEntry('openai')
	const body: any = { model: req.model, store: false, stream: true, input: convertResponsesMessages(req.messages) }
	if (req.systemPrompt) body.instructions = req.systemPrompt
	if (transport.usesCodexBackend) {
		body.text = { verbosity: 'high' }
		body.include = ['reasoning.encrypted_content']
		if (req.sessionId) body.prompt_cache_key = req.sessionId
	} else {
		body.max_output_tokens = req.model.includes('codex') ? 128_000 : 16_384
	}
	if (req.tools?.length) {
		body.tools = convertResponsesTools(req.tools)
		body.tool_choice = 'auto'
		body.parallel_tool_calls = true
	}
	const effort = models.reasoningEffort(req.model)
	if (effort) body.reasoning = { effort, summary: 'auto' }
	openaiUsage.setCurrentCredential(credential)
	const rotationActivity = providerShared.formatRotationActivity('OpenAI', credential)
	if (rotationActivity) yield { type: 'status', activity: rotationActivity }
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
		Authorization: `Bearer ${credential.value}`,
		accept: 'text/event-stream',
	}
	if (transport.usesCodexBackend) {
		const accountId = transport.accountId || openaiEntry.accountId || ''
		if (!accountId) {
			yield* yieldErrorAndDone({ type: 'error', message: 'OpenAI token missing chatgpt_account_id' })
			return
		}
		headers['OpenAI-Beta'] = 'responses=experimental'
		headers.originator = 'pi'
		headers['chatgpt-account-id'] = accountId
	}
	const res = await fetch(transport.apiUrl, {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
		signal: req.signal,
	})
	if (!res.ok) {
		const text = await readErrorBody(res)
		const retryAfterMs = providerShared.parseRetryDelay(res, text)
		if (res.status === 429) {
			const cooldownMs = parseResetsInSeconds(text) ?? retryAfterMs ?? 10 * 60_000
			auth.markCooldown(credential, cooldownMs)
			const fast = auth.hasAvailableCredential('openai')
			const nextCredential = auth.getCredential('openai')
			yield* yieldErrorAndDone({
				type: 'error',
				message: providerShared.formatRotationMessage('OpenAI', credential, nextCredential, fast ? 1_000 : cooldownMs, fast),
				status: res.status,
				body: text,
				endpoint: transport.apiUrl,
				retryAfterMs: fast ? 1_000 : cooldownMs,
			})
			return
		}
		yield* yieldErrorAndDone({ type: 'error', message: `openai ${res.status}: ${res.statusText}`, status: res.status, body: text, endpoint: transport.apiUrl, retryAfterMs })
		return
	}
	for await (const event of parseResponsesStream(res.body!)) {
		if (event.type === 'done' && event.usage) openaiUsage.recordUsage(credential, event.usage)
		yield event
	}
}

export const openaiProvider: Provider = { generate: generateOpenAI }

/** Create a Chat Completions-compatible provider for any OpenAI-like endpoint. */
export function createCompatProvider(providerName: string, baseUrl?: string): Provider {
	const url = baseUrl ?? providerShared.compatEndpoints[providerName]
	if (!url) {
		throw new Error(
			`Unknown compat provider '${providerName}'. ` +
				`Known endpoints: ${Object.keys(providerShared.compatEndpoints).join(', ')}. ` +
				`Or pass a custom baseUrl.`,
		)
	}
	return { generate: (req) => generateCompat(providerName, url, req) }
}

export const openai = { openaiProvider, createCompatProvider, convertResponsesMessages }
