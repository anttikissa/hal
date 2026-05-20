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
import { ason } from '../utils/ason.ts'

const RESPONSES_API_URL = 'https://api.openai.com/v1/responses'
const CODEX_BASE_URL = 'https://chatgpt.com/backend-api'

type ResponsesTransportMode = 'http' | 'ws' | 'auto'

const config = {
	// http: current SSE path. ws: force Responses WebSocket. auto: try WS, fall back to HTTP.
	responsesTransport: 'http' as ResponsesTransportMode,
}

const state = {
	webSockets: new Map<string, ResponsesWebSocketChain>(),
}

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

function responsesWsUrl(apiUrl: string): string {
	if (apiUrl.startsWith('https://')) return `wss://${apiUrl.slice('https://'.length)}`
	if (apiUrl.startsWith('http://')) return `ws://${apiUrl.slice('http://'.length)}`
	return apiUrl
}

function resolveOpenAITransport(credential: Credential): OpenAITransport {
	if (credential.type === 'api-key') return { apiUrl: RESPONSES_API_URL, wsUrl: responsesWsUrl(RESPONSES_API_URL), usesCodexBackend: false, accountId: null }
	const token = inspectOpenAIToken(credential.value)
	const apiUrl = token.hasResponsesScope ? RESPONSES_API_URL : `${CODEX_BASE_URL}/codex/responses`
	return {
		apiUrl,
		wsUrl: responsesWsUrl(apiUrl),
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

interface OpenAITransport {
	apiUrl: string
	wsUrl: string
	usesCodexBackend: boolean
	accountId: string | null
}

interface ResponsesWebSocketChain {
	key: string
	ws: WebSocket
	previousResponseId: string
	requestMessageCount: number
	busy: boolean
	opened: boolean
	openPromise: Promise<void>
}

class ResponsesWebSocketFallback extends Error {}

class ResponsesWebSocketApiError extends ResponsesWebSocketFallback {
	status?: number
	body: string

	constructor(event: any) {
		const message = event.error?.message ?? event.message ?? 'OpenAI Responses WebSocket error'
		super(message)
		this.status = event.status
		this.body = JSON.stringify(event.error ?? event)
	}
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

function responsesTransportMode(): ResponsesTransportMode {
	const value = process.env.HAL_OPENAI_RESPONSES_TRANSPORT ?? config.responsesTransport
	if (value === 'ws' || value === 'auto') return value
	return 'http'
}

function buildResponsesBody(req: ProviderRequest, transport: OpenAITransport, input: any[], streaming: boolean): any {
	const body: any = { model: req.model, store: false, input }
	if (streaming) body.stream = true
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
	return body
}

function responsesHeaders(credential: Credential, transport: OpenAITransport, openaiEntry: Record<string, any>, streaming: boolean): { headers?: Record<string, string>; error?: string } {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${credential.value}`,
	}
	if (streaming) {
		headers['Content-Type'] = 'application/json'
		headers.accept = 'text/event-stream'
	}
	if (transport.usesCodexBackend) {
		const accountId = transport.accountId || openaiEntry.accountId || ''
		if (!accountId) return { error: 'OpenAI token missing chatgpt_account_id' }
		headers['OpenAI-Beta'] = 'responses=experimental'
		headers.originator = 'pi'
		headers['chatgpt-account-id'] = accountId
	}
	return { headers }
}

function webSocketKey(req: ProviderRequest, credential: Credential, transport: OpenAITransport): string {
	return [
		transport.wsUrl,
		credential.type,
		credential._key ?? credential.email ?? credential.index ?? '',
		req.model,
		req.systemPrompt,
		ason.stringify(req.tools ?? []),
	].join('\n')
}

function incrementalInput(chain: ResponsesWebSocketChain, messages: Message[]): any[] | null {
	if (!chain.previousResponseId) return null
	if (messages.length < chain.requestMessageCount) return null
	let start = chain.requestMessageCount
	if (messages[start]?.role === 'assistant') start++
	return convertResponsesMessages(messages.slice(start))
}

function closeResponsesWebSocket(sessionId: string): void {
	const chain = state.webSockets.get(sessionId)
	if (!chain) return
	state.webSockets.delete(sessionId)
	try {
		chain.ws.close()
	} catch {}
}

function resetResponsesWebSocketsForTests(): void {
	for (const sessionId of state.webSockets.keys()) closeResponsesWebSocket(sessionId)
	state.webSockets.clear()
}

function waitForWebSocketOpen(ws: WebSocket, signal?: AbortSignal): Promise<void> {
	if (ws.readyState === 1) return Promise.resolve()
	return new Promise((resolve, reject) => {
		function cleanup(): void {
			ws.removeEventListener?.('open', onOpen as any)
			ws.removeEventListener?.('error', onError as any)
			signal?.removeEventListener('abort', onAbort)
		}
		function onOpen(): void {
			cleanup()
			resolve()
		}
		function onError(): void {
			cleanup()
			reject(new ResponsesWebSocketFallback('OpenAI Responses WebSocket connect failed'))
		}
		function onAbort(): void {
			cleanup()
			reject(new Error('aborted'))
		}
		ws.addEventListener('open', onOpen as any, { once: true } as any)
		ws.addEventListener('error', onError as any, { once: true } as any)
		signal?.addEventListener('abort', onAbort, { once: true })
	})
}

function getResponsesWebSocket(sessionId: string, key: string, url: string, headers: Record<string, string>, signal?: AbortSignal): ResponsesWebSocketChain {
	const existing = state.webSockets.get(sessionId)
	if (existing && existing.key === key && existing.ws.readyState !== 2 && existing.ws.readyState !== 3) return existing
	if (existing) closeResponsesWebSocket(sessionId)
	const ws = new WebSocket(url, { headers } as any)
	const chain: ResponsesWebSocketChain = {
		key,
		ws,
		previousResponseId: '',
		requestMessageCount: 0,
		busy: false,
		opened: false,
		openPromise: waitForWebSocketOpen(ws, signal).then(() => {
			chain.opened = true
		}),
	}
	state.webSockets.set(sessionId, chain)
	return chain
}

function compatCredentialMessage(providerName: string): string {
	return `No credentials for '${providerName}'. Set ${providerName.toUpperCase()}_API_KEY`
}

async function* generateCompat(providerName: string, baseUrl: string, req: ProviderRequest): AsyncGenerator<ProviderStreamEvent> {
	await auth.ensureFresh(providerName)
	const credential = auth.getCredential(providerName)
	if (!credential) {
		yield* yieldErrorAndDone({
			type: 'error',
			message: compatCredentialMessage(providerName),
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

async function* streamResponsesWebSocket(chain: ResponsesWebSocketChain, body: any, signal?: AbortSignal): AsyncGenerator<{ event: ProviderStreamEvent; responseId?: string }> {
	if (chain.busy) throw new ResponsesWebSocketFallback('OpenAI Responses WebSocket already has an in-flight request')
	chain.busy = true
	const pending: any[] = []
	const streamState: ResponsesStreamState = { itemMap: new Map(), toolInputs: new Map() }
	let done = false
	let failed: Error | null = null
	let responseId = ''
	let wake: (() => void) | null = null

	function notify(): void {
		if (!wake) return
		const fn = wake
		wake = null
		fn()
	}
	function cleanup(): void {
		chain.busy = false
		chain.ws.removeEventListener?.('message', onMessage as any)
		chain.ws.removeEventListener?.('error', onError as any)
		chain.ws.removeEventListener?.('close', onClose as any)
		signal?.removeEventListener('abort', onAbort)
	}
	function onMessage(event: MessageEvent): void {
		try {
			const parsed = JSON.parse(String(event.data))
			pending.push(parsed)
			if (parsed.type === 'error') failed = new ResponsesWebSocketApiError(parsed)
			if (parsed.type === 'response.completed') {
				responseId = parsed.response?.id ?? responseId
				done = true
			}
			notify()
		} catch (err) {
			failed = err instanceof Error ? err : new Error(String(err))
			notify()
		}
	}
	function onError(): void {
		failed = new ResponsesWebSocketFallback('OpenAI Responses WebSocket error')
		notify()
	}
	function onClose(): void {
		if (!done) failed = new ResponsesWebSocketFallback('OpenAI Responses WebSocket closed before response.completed')
		notify()
	}
	function onAbort(): void {
		failed = new Error('aborted')
		notify()
	}

	try {
		await chain.openPromise
		chain.ws.addEventListener('message', onMessage as any)
		chain.ws.addEventListener('error', onError as any)
		chain.ws.addEventListener('close', onClose as any)
		signal?.addEventListener('abort', onAbort, { once: true })
		chain.ws.send(JSON.stringify(body))
		while (!done || pending.length > 0) {
			while (pending.length > 0) {
				const raw = pending.shift()
				if (raw?.type === 'error') throw failed ?? new ResponsesWebSocketFallback('OpenAI Responses WebSocket error')
				if (raw?.response?.id) responseId = raw.response.id
				for (const event of parseResponsesEvent(streamState, raw)) yield { event, responseId }
			}
			if (failed) throw failed
			if (!done) await new Promise<void>((resolve) => { wake = resolve })
		}
	} finally {
		cleanup()
	}
}

async function* generateOpenAIWebSocket(req: ProviderRequest, credential: Credential, transport: OpenAITransport, openaiEntry: Record<string, any>): AsyncGenerator<ProviderStreamEvent> {
	const sessionId = req.sessionId ?? 'default'
	const headerResult = responsesHeaders(credential, transport, openaiEntry, false)
	if (headerResult.error || !headerResult.headers) {
		yield* yieldErrorAndDone({ type: 'error', message: headerResult.error ?? 'OpenAI WebSocket headers unavailable' })
		return
	}
	const key = webSocketKey(req, credential, transport)
	const chain = getResponsesWebSocket(sessionId, key, transport.wsUrl, headerResult.headers, req.signal)
	const deltaInput = incrementalInput(chain, req.messages)
	const input = deltaInput ?? convertResponsesMessages(req.messages)
	const body = buildResponsesBody(req, transport, input, false)
	body.type = 'response.create'
	if (deltaInput && chain.previousResponseId) body.previous_response_id = chain.previousResponseId

	let completedResponseId = ''
	for await (const item of streamResponsesWebSocket(chain, body, req.signal)) {
		if (item.responseId) completedResponseId = item.responseId
		if (item.event.type === 'done' && item.event.usage) openaiUsage.recordUsage(credential, item.event.usage)
		yield item.event
	}
	if (completedResponseId) {
		chain.previousResponseId = completedResponseId
		chain.requestMessageCount = req.messages.length
	}
}

async function* generateOpenAIHttp(req: ProviderRequest, credential: Credential, transport: OpenAITransport, openaiEntry: Record<string, any>): AsyncGenerator<ProviderStreamEvent> {
	if (req.sessionId) closeResponsesWebSocket(req.sessionId)
	const body = buildResponsesBody(req, transport, convertResponsesMessages(req.messages), true)
	const headerResult = responsesHeaders(credential, transport, openaiEntry, true)
	if (headerResult.error || !headerResult.headers) {
		yield* yieldErrorAndDone({ type: 'error', message: headerResult.error ?? 'OpenAI headers unavailable' })
		return
	}
	const res = await fetch(transport.apiUrl, {
		method: 'POST',
		headers: headerResult.headers,
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

function webSocketApiErrorEvent(err: ResponsesWebSocketApiError, credential: Credential, transport: OpenAITransport): ProviderStreamEvent {
	if (err.status === 429) {
		const cooldownMs = parseResetsInSeconds(err.body) ?? 10 * 60_000
		auth.markCooldown(credential, cooldownMs)
		const fast = auth.hasAvailableCredential('openai')
		const nextCredential = auth.getCredential('openai')
		return {
			type: 'error',
			message: providerShared.formatRotationMessage('OpenAI', credential, nextCredential, fast ? 1_000 : cooldownMs, fast),
			status: err.status,
			body: err.body,
			endpoint: transport.wsUrl,
			retryAfterMs: fast ? 1_000 : cooldownMs,
		}
	}
	return { type: 'error', message: err.message, status: err.status, body: err.body, endpoint: transport.wsUrl }
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
	openaiUsage.setCurrentCredential(credential)
	const rotationActivity = providerShared.formatRotationActivity('OpenAI', credential)
	if (rotationActivity) yield { type: 'status', activity: rotationActivity }

	const mode = responsesTransportMode()
	if (mode === 'http') {
		yield* generateOpenAIHttp(req, credential, transport, openaiEntry)
		return
	}

	try {
		yield* generateOpenAIWebSocket(req, credential, transport, openaiEntry)
		return
	} catch (err) {
		if (req.sessionId) closeResponsesWebSocket(req.sessionId)
		if (mode === 'auto' && !req.signal?.aborted) {
			yield { type: 'status', activity: 'OpenAI WS failed; falling back to HTTP' }
			yield* generateOpenAIHttp(req, credential, transport, openaiEntry)
			return
		}
		if (err instanceof ResponsesWebSocketApiError) {
			yield* yieldErrorAndDone(webSocketApiErrorEvent(err, credential, transport))
			return
		}
		const message = err instanceof Error ? err.message : String(err)
		yield* yieldErrorAndDone({ type: 'error', message, endpoint: transport.wsUrl })
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

export const openai = { config, state, openaiProvider, createCompatProvider, convertResponsesMessages, resetResponsesWebSocketsForTests }
