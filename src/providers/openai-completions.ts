import { Provider, type StreamEvent, type ToolDef } from '../provider.ts'
import { getProviderAuth } from '../auth.ts'

interface OpenAICompletionsOptions {
	name: string
	baseUrl: string | (() => string)
	providerAuthName?: string
	headers?: Record<string, string> | (() => Record<string, string>)
	maxTokensField?: 'max_tokens' | 'max_completion_tokens'
	includeUsageInStream?: boolean
}

interface StreamState {
	nextBlockIndex: number
	textBlockByChoice: Map<number, number>
	toolBlockByKey: Map<string, number>
	startedTextByChoice: Set<number>
	startedToolByKey: Set<string>
}

function systemToText(system: any[]): string {
	return system
		.map((s: any) => (typeof s === 'string' ? s : (s.text ?? JSON.stringify(s))))
		.join('\n\n')
}

function asText(value: unknown): string {
	if (typeof value === 'string') return value
	return JSON.stringify(value)
}

function imageDataUrl(block: any): string {
	if (typeof block.image_url === 'string') return block.image_url
	const mediaType = block.source?.media_type ?? 'image/png'
	const data = block.source?.data ?? block.data ?? ''
	return `data:${mediaType};base64,${data}`
}

function convertMessages(messages: any[]): any[] {
	const out: any[] = []
	for (const msg of messages) {
		if (msg.role === 'user') {
			if (!Array.isArray(msg.content)) {
				out.push({ role: 'user', content: asText(msg.content) })
				continue
			}
			const toolResults = msg.content.filter((b: any) => b.type === 'tool_result')
			if (toolResults.length > 0) {
				for (const tr of toolResults) {
					out.push({
						role: 'tool',
						tool_call_id: tr.tool_use_id,
						content: asText(tr.content),
					})
				}
				continue
			}
			const parts = msg.content
				.map((b: any) => {
					if (b.type === 'text') return { type: 'text', text: b.text ?? '' }
					if (b.type === 'image') {
						return {
							type: 'image_url',
							image_url: { url: imageDataUrl(b) },
						}
					}
					return { type: 'text', text: asText(b) }
				})
				.filter((p: any) => (p.type === 'text' ? p.text.length > 0 : true))
			if (parts.length === 0) {
				out.push({ role: 'user', content: '' })
			} else if (parts.length === 1 && parts[0].type === 'text') {
				out.push({ role: 'user', content: parts[0].text })
			} else {
				out.push({ role: 'user', content: parts })
			}
			continue
		}
		if (msg.role !== 'assistant') continue
		if (!Array.isArray(msg.content)) {
			out.push({ role: 'assistant', content: asText(msg.content) })
			continue
		}
		for (const block of msg.content) {
			if (block.type === 'text') {
				out.push({ role: 'assistant', content: block.text ?? '' })
				continue
			}
			if (block.type !== 'tool_use') continue
			out.push({
				role: 'assistant',
				content: '',
				tool_calls: [
					{
						id: block.id,
						type: 'function',
						function: {
							name: block.name,
							arguments:
								typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? {}),
						},
					},
				],
			})
		}
	}
	return out
}

function convertTools(tools: ToolDef[]): any[] {
	return tools
		.filter((t) => !t.type || t.type === 'custom')
		.map((t) => ({
			type: 'function',
			function: {
				name: t.name,
				description: t.description,
				parameters: t.input_schema,
			},
		}))
}

function streamState(): StreamState {
	return {
		nextBlockIndex: 0,
		textBlockByChoice: new Map(),
		toolBlockByKey: new Map(),
		startedTextByChoice: new Set(),
		startedToolByKey: new Set(),
	}
}

function extractErrorMessage(payload: any): string {
	if (!payload || typeof payload !== 'object') return 'unknown'
	for (const candidate of [
		payload.message,
		payload.error?.message,
		payload.error?.code,
		payload.code,
		payload.response?.error?.message,
	]) {
		if (typeof candidate === 'string' && candidate.trim()) return candidate
	}
	return 'unknown'
}

function stopReasonFromFinishReason(finishReason: string): string {
	if (finishReason === 'tool_calls' || finishReason === 'function_call') return 'tool_use'
	if (finishReason === 'length') return 'max_tokens'
	if (finishReason === 'content_filter') return 'error'
	return 'end_turn'
}

function normalizeBaseUrl(baseUrl: string): string {
	return baseUrl.replace(/\/+$/, '')
}

export class OpenAICompletionsProvider extends Provider {
	name: string
	private readonly options: OpenAICompletionsOptions
	private readonly streams = new Map<string, StreamState>()

	constructor(options: OpenAICompletionsOptions) {
		super()
		this.options = options
		this.name = options.name
	}

	private getBaseUrl(): string {
		const resolved = typeof this.options.baseUrl === 'function' ? this.options.baseUrl() : this.options.baseUrl
		return normalizeBaseUrl(resolved)
	}

	private getHeaders(): Record<string, string> {
		if (!this.options.headers) return {}
		return typeof this.options.headers === 'function' ? this.options.headers() : this.options.headers
	}

	private getToken(): string {
		const authProvider = this.options.providerAuthName ?? this.name
		return getProviderAuth(authProvider)?.accessToken ?? ''
	}

	private getStream(id: string): StreamState {
		const existing = this.streams.get(id)
		if (existing) return existing
		const created = streamState()
		this.streams.set(id, created)
		if (this.streams.size > 32) {
			const oldest = this.streams.keys().next().value
			if (oldest) this.streams.delete(oldest)
		}
		return created
	}

	private textBlockIndex(state: StreamState, choiceIndex: number): number {
		const existing = state.textBlockByChoice.get(choiceIndex)
		if (existing !== undefined) return existing
		const created = state.nextBlockIndex++
		state.textBlockByChoice.set(choiceIndex, created)
		return created
	}

	private toolBlockIndex(state: StreamState, choiceIndex: number, toolIndex: number): number {
		const key = `${choiceIndex}:${toolIndex}`
		const existing = state.toolBlockByKey.get(key)
		if (existing !== undefined) return existing
		const created = state.nextBlockIndex++
		state.toolBlockByKey.set(key, created)
		return created
	}

	async fetch(body: any, signal?: AbortSignal): Promise<Response> {
		const token = this.getToken()
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			'User-Agent': 'hal-claude/0.1.0',
			...this.getHeaders(),
		}
		if (body?.stream === true) headers.accept = 'text/event-stream'
		if (token) headers.Authorization = `Bearer ${token}`
		return fetch(`${this.getBaseUrl()}/chat/completions`, {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
			signal,
		})
	}

	buildRequestBody({ model, messages, system, tools, maxTokens }: any): any {
		const bodyMessages = convertMessages(messages)
		const systemText = systemToText(system)
		if (systemText) bodyMessages.unshift({ role: 'system', content: systemText })

		const body: any = {
			model,
			messages: bodyMessages,
			stream: true,
		}
		const maxField = this.options.maxTokensField ?? 'max_tokens'
		body[maxField] = maxTokens

		if (this.options.includeUsageInStream) {
			body.stream_options = { include_usage: true }
		}

		const completionTools = convertTools(tools)
		if (completionTools.length > 0) {
			body.tools = completionTools
			body.tool_choice = 'auto'
		}
		return body
	}

	parseSSE(rawEvent: { type: string; data: string }): StreamEvent[] {
		if (rawEvent.data === '[DONE]') return []

		let event: any
		try {
			event = JSON.parse(rawEvent.data)
		} catch {
			return []
		}

		if (event?.error) {
			const code =
				(typeof event?.code === 'string' && event.code) ||
				(typeof event?.error?.code === 'string' && event.error.code) ||
				'error'
			return [{ type: 'error', message: `${code}: ${extractErrorMessage(event)}` }]
		}

		const events: StreamEvent[] = []
		if (event?.usage && typeof event.usage === 'object') {
			events.push({
				type: 'usage',
				usage: {
					prompt_tokens: event.usage.prompt_tokens ?? 0,
					completion_tokens: event.usage.completion_tokens ?? 0,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
			})
		}

		const streamId = typeof event?.id === 'string' && event.id ? event.id : '__default'
		const state = this.getStream(streamId)
		for (const choice of Array.isArray(event?.choices) ? event.choices : []) {
			const choiceIndex = Number.isInteger(choice?.index) ? choice.index : 0
			const delta = choice?.delta ?? {}
			if (typeof delta.content === 'string' && delta.content.length > 0) {
				const blockIndex = this.textBlockIndex(state, choiceIndex)
				if (!state.startedTextByChoice.has(choiceIndex)) {
					state.startedTextByChoice.add(choiceIndex)
					events.push({ type: 'text_start', index: blockIndex })
				}
				events.push({ type: 'text_delta', index: blockIndex, text: delta.content })
			}

			for (const toolCall of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
				const toolIndex = Number.isInteger(toolCall?.index) ? toolCall.index : 0
				const toolKey = `${choiceIndex}:${toolIndex}`
				const blockIndex = this.toolBlockIndex(state, choiceIndex, toolIndex)
				if (!state.startedToolByKey.has(toolKey)) {
					state.startedToolByKey.add(toolKey)
					events.push({
						type: 'tool_use_start',
						index: blockIndex,
						id: toolCall?.id ?? `call_${blockIndex}`,
						name: toolCall?.function?.name ?? '',
					})
				}
				const args = toolCall?.function?.arguments
				if (typeof args === 'string' && args.length > 0) {
					events.push({ type: 'tool_input_delta', index: blockIndex, json: args })
				}
			}

			if (typeof choice?.finish_reason === 'string' && choice.finish_reason) {
				const textBlock = state.textBlockByChoice.get(choiceIndex)
				if (textBlock !== undefined) {
					events.push({ type: 'block_stop', index: textBlock })
					state.textBlockByChoice.delete(choiceIndex)
					state.startedTextByChoice.delete(choiceIndex)
				}
				for (const [key, idx] of state.toolBlockByKey.entries()) {
					if (!key.startsWith(`${choiceIndex}:`)) continue
					events.push({ type: 'block_stop', index: idx })
					state.toolBlockByKey.delete(key)
					state.startedToolByKey.delete(key)
				}
				events.push({
					type: 'stop',
					stopReason: stopReasonFromFinishReason(choice.finish_reason),
				})
				this.streams.delete(streamId)
			}
		}

		return events
	}

	normalizeUsage(usage: Record<string, number>): {
		input: number
		output: number
		cacheCreate: number
		cacheRead: number
	} {
		return {
			input: usage.prompt_tokens ?? usage.input_tokens ?? 0,
			output: usage.completion_tokens ?? usage.output_tokens ?? 0,
			cacheCreate: usage.cache_creation_input_tokens ?? 0,
			cacheRead: usage.cache_read_input_tokens ?? 0,
		}
	}

	async complete({ model, system, userMessage, maxTokens }: any): Promise<{ text: string; error?: string; truncated?: boolean }> {
		const messages: any[] = []
		if (system?.trim()) messages.push({ role: 'system', content: system })
		messages.push({ role: 'user', content: userMessage })
		const body: any = {
			model,
			messages,
			stream: false,
		}
		const maxField = this.options.maxTokensField ?? 'max_tokens'
		body[maxField] = maxTokens

		const res = await this.fetch(body)
		let data: any
		try {
			data = await res.json()
		} catch {
			data = {}
		}
		if (!res.ok || data?.error) {
			return { text: '', error: extractErrorMessage(data) }
		}
		const choice = Array.isArray(data?.choices) ? data.choices[0] : null
		const content = choice?.message?.content
		let text = ''
		if (typeof content === 'string') {
			text = content
		} else if (Array.isArray(content)) {
			text = content
				.filter((part: any) => part?.type === 'text' || part?.type === 'output_text')
				.map((part: any) => part?.text ?? '')
				.join('')
		}
		const truncated = choice?.finish_reason === 'length'
		return { text: text || 'No response.', truncated }
	}
}
