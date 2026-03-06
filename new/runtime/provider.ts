// Provider interface — adapters implement this.

export type ProviderEvent =
	| { type: 'thinking'; text: string }
	| { type: 'text'; text: string }
	| { type: 'tool_call'; id: string; name: string; input: unknown }
	| { type: 'done'; usage?: { input: number; output: number } }
	| { type: 'error'; message: string }

export interface GenerateParams {
	messages: any[]
	model: string
	systemPrompt: string
}

export interface Provider {
	name: string
	generate(params: GenerateParams): AsyncGenerator<ProviderEvent>
}

const cache = new Map<string, Provider>()

export async function loadProvider(name: string): Promise<Provider> {
	const cached = cache.get(name)
	if (cached) return cached
	const mod = await import(`./${name}-provider.ts`)
	const provider: Provider = mod.default ?? mod.provider
	cache.set(name, provider)
	return provider
}
