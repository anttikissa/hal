// Provider interface — adapters implement this.

export type ProviderEvent =
	| { type: 'thinking'; text: string }
	| { type: 'thinking_signature'; signature: string }
	| { type: 'text'; text: string }
	| { type: 'tool_call'; id: string; name: string; input: unknown }
	| { type: 'done'; usage?: { input: number; output: number } }
	| { type: 'error'; message: string; status?: number; body?: string }

export interface GenerateParams {
	messages: any[]
	model: string
	systemPrompt: string
	tools?: any[]
	signal?: AbortSignal
	sessionId?: string
}

export interface Provider {
	name: string
	generate(params: GenerateParams): AsyncGenerator<ProviderEvent>
}
