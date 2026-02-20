export type StreamEvent =
	| { type: "text_start"; index: number }
	| { type: "text_delta"; index: number; text: string }
	| { type: "thinking_start"; index: number }
	| { type: "thinking_delta"; index: number; text: string }
	| { type: "signature_delta"; index: number; signature: string }
	| { type: "tool_use_start"; index: number; id: string; name: string }
	| { type: "tool_input_delta"; index: number; json: string }
	| { type: "raw_block"; index: number; block: any }
	| { type: "block_stop"; index: number }
	| { type: "web_search"; query: string }
	| { type: "web_search_results"; results: string }
	| { type: "usage"; usage: Record<string, number> }
	| { type: "stop"; stopReason: string }
	| { type: "error"; message: string }

export interface ToolDef {
	name: string
	description?: string
	input_schema?: any
	type?: string
	max_uses?: number
	cache_control?: { type: string }
}

export interface Provider {
	name: string
	refreshAuth(): Promise<void>
	getHeaders(): Record<string, string>
	buildRequestBody(params: {
		model: string
		messages: any[]
		system: any[]
		tools: ToolDef[]
		maxTokens: number
		sessionId?: string
	}): any
	apiUrl: string
	parseSSE(event: { type: string; data: string }): StreamEvent[]
	finalizeBlocks(blocks: any[]): any[]
	addCacheBreakpoints(messages: any[]): any[]
	toolResultMessage(toolUseId: string, content: string): any
	normalizeUsage(usage: Record<string, number>): {
		input: number
		output: number
		cacheCreate: number
		cacheRead: number
	}
	complete(params: {
		model: string
		system: string
		userMessage: string
		maxTokens: number
	}): Promise<{ text: string; error?: string }>
}

const providers = new Map<string, Provider>()

export function registerProvider(provider: Provider): void {
	providers.set(provider.name, provider)
}

export function getProvider(name: string): Provider {
	const p = providers.get(name)
	if (!p) throw new Error(`Unknown provider: ${name}. Available: ${[...providers.keys()].join(", ")}`)
	return p
}

export function listProviders(): string[] {
	return [...providers.keys()]
}
