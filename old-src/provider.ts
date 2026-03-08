export type StreamEvent =
	| { type: 'text_start'; index: number }
	| { type: 'text_delta'; index: number; text: string }
	| { type: 'thinking_start'; index: number }
	| { type: 'thinking_delta'; index: number; text: string }
	| { type: 'activity'; text: string }
	| { type: 'signature_delta'; index: number; signature: string }
	| { type: 'tool_use_start'; index: number; id: string; name: string }
	| { type: 'tool_input_delta'; index: number; json: string }
	| { type: 'raw_block'; index: number; block: any }
	| { type: 'block_stop'; index: number }
	| { type: 'web_search'; query: string }
	| { type: 'web_search_results'; results: string }
	| { type: 'usage'; usage: Record<string, number> }
	| { type: 'stop'; stopReason: string }
	| { type: 'error'; message: string }

export interface ToolDef {
	name: string
	description?: string
	input_schema?: any
	type?: string
	max_uses?: number
	cache_control?: { type: string }
}

export interface RequestParams {
	model: string
	messages: any[]
	system: any[]
	tools: ToolDef[]
	maxTokens: number
	sessionId?: string
}

/**
 * Base provider class with Anthropic SSE format as default.
 * Subclasses override what they need.
 */
export abstract class Provider {
	abstract name: string

	async refreshAuth(): Promise<void> {}

	abstract fetch(body: any, signal?: AbortSignal): Promise<Response>

	abstract buildRequestBody(params: RequestParams): any

	/** Parse an SSE event into normalized StreamEvents. Default: Anthropic format. */
	parseSSE(rawEvent: { type: string; data: string }): StreamEvent[] {
		let event: any
		try {
			event = JSON.parse(rawEvent.data)
		} catch {
			return []
		}

		if (event.type === 'message_start') {
			if (event.message?.usage) return [{ type: 'usage', usage: event.message.usage }]
			return []
		}

		if (event.type === 'content_block_start') {
			const block = event.content_block
			const idx = event.index
			if (block.type === 'thinking') return [{ type: 'thinking_start', index: idx }]
			if (block.type === 'text') return [{ type: 'text_start', index: idx }]
			if (block.type === 'tool_use')
				return [{ type: 'tool_use_start', index: idx, id: block.id, name: block.name }]
			if (block.type === 'server_tool_use' && block.name === 'web_search') {
				return [{ type: 'raw_block', index: idx, block: { ...block } }]
			}
			if (block.type === 'web_search_tool_result') {
				const results = (block.content || [])
					.filter((r: any) => r.type === 'web_search_result')
					.map((r: any, i: number) => `${i + 1}. ${r.title} - ${r.url}`)
					.join('\n')
				const events: StreamEvent[] = [
					{ type: 'raw_block', index: idx, block: { ...block } },
				]
				if (results) events.push({ type: 'web_search_results', results })
				return events
			}
			return []
		}

		if (event.type === 'content_block_delta') {
			const delta = event.delta
			const idx = event.index
			if (delta.type === 'thinking_delta')
				return [{ type: 'thinking_delta', index: idx, text: delta.thinking }]
			if (delta.type === 'text_delta')
				return [{ type: 'text_delta', index: idx, text: delta.text }]
			if (delta.type === 'input_json_delta')
				return [{ type: 'tool_input_delta', index: idx, json: delta.partial_json }]
			if (delta.type === 'signature_delta')
				return [{ type: 'signature_delta', index: idx, signature: delta.signature }]
		}

		if (event.type === 'content_block_stop') {
			return [{ type: 'block_stop', index: event.index }]
		}

		if (event.type === 'message_delta') {
			const events: StreamEvent[] = []
			if (event.delta?.stop_reason)
				events.push({ type: 'stop', stopReason: event.delta.stop_reason })
			if (event.usage) events.push({ type: 'usage', usage: event.usage })
			return events
		}

		if (event.type === 'error') {
			const msg = event.error?.message ?? JSON.stringify(event.error ?? event)
			return [{ type: 'error', message: msg }]
		}

		return []
	}

	/** Post-process content blocks after stream ends. Default: JSON-parse tool inputs. */
	finalizeBlocks(blocks: any[]): any[] {
		for (const block of blocks) {
			if (!block) continue
			if (block.type === 'tool_use' && typeof block.input === 'string') {
				try {
					block.input = JSON.parse(block.input)
				} catch {
					block.input = {}
				}
			}
		}
		return blocks
	}

	/** Add cache breakpoints to messages. Default: no-op. */
	addCacheBreakpoints(messages: any[]): any[] {
		return messages
	}

	/** Wrap tool output in the right message format. */
	toolResultMessage(toolUseId: string, content: string): any {
		return {
			role: 'user',
			content: [{ type: 'tool_result', tool_use_id: toolUseId, content }],
		}
	}

	/** Normalize provider-specific usage into standard fields. */
	normalizeUsage(usage: Record<string, number>): {
		input: number
		output: number
		cacheCreate: number
		cacheRead: number
	} {
		return {
			input: usage.input_tokens ?? 0,
			output: usage.output_tokens ?? 0,
			cacheCreate: usage.cache_creation_input_tokens ?? 0,
			cacheRead: usage.cache_read_input_tokens ?? 0,
		}
	}

	/** Non-streaming completion for compact operations (handoff summaries, etc.). */
	abstract complete(params: {
		model: string
		system: string
		userMessage: string
		maxTokens: number
	}): Promise<{ text: string; error?: string; truncated?: boolean }>
}

const providers = new Map<string, Provider>()

export function registerProvider(provider: Provider): void {
	providers.set(provider.name, provider)
}

export function getProvider(name: string): Provider {
	const p = providers.get(name)
	if (!p)
		throw new Error(`Unknown provider: ${name}. Available: ${[...providers.keys()].join(', ')}`)
	return p
}

export function listProviders(): string[] {
	return [...providers.keys()]
}
