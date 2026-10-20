// The OpenAI-compatible providers (OpenRouter, OpenCode Go, Ollama) in
// one table: base URL, key, login and capabilities. create() makes a
// provider that loads openai-compat.ts only when first used.
import { apiKeys } from './api-keys.ts'
import type { Capability } from './model-effort.ts'
import { effortCatalog } from './effort-catalog.ts'
import type { Provider, ProviderRequest } from './provider.ts'

export type Endpoint = {
	baseUrl: string
	keyEnv?: string
	login?: string
	images?: false
	models?: false
	headers?: (req: ProviderRequest) => Record<string, string>
	capability?: (model: string) => Capability | undefined
}

function cachedCapability(name: string, model: string): Capability | undefined {
	if (name === 'openrouter' && compatCatalog.state.catalog !== effortCatalog.file()) {
		compatCatalog.state.capabilities.clear()
		for (let [id, cap] of Object.entries(effortCatalog.read()))
			compatCatalog.state.capabilities.set(id, { ...cap, wire: (level) => ({ reasoning: { effort: level } }) })
		compatCatalog.state.catalog = effortCatalog.file()
	}
	return compatCatalog.state.capabilities.get(`${name}/${model}`)
}

function create(name: string): Provider {
	let implementation: Provider | undefined
	let load = () =>
		(implementation ??= (require('./openai-compat.ts') as typeof import('./openai-compat.ts')).openaiCompat.create(
			name,
		))
	let p: Provider = {
		request: (req) => load().request(req),
		parse: (messages) => load().parse(messages),
		available: () => {
			let env = compatCatalog.endpoints()[name]?.keyEnv
			return !env || !!(apiKeys.get(name) ?? process.env[env])
		},
		capability: (model) =>
			compatCatalog.endpoints()[name]?.capability?.(model) ?? compatCatalog.cachedCapability(name, model),
	}
	if (compatCatalog.endpoints()[name]?.models !== false) p.models = (signal) => load().models!(signal)
	return p
}

export const compatCatalog = {
	state: { capabilities: new Map<string, Capability>(), catalog: '' },
	cachedCapability,
	create,
	endpoints(): Record<string, Endpoint> {
		return {
			openrouter: { baseUrl: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY' },
			'opencode-go': {
				baseUrl: 'https://opencode.ai/zen/go/v1',
				keyEnv: 'OPENCODE_API_KEY',
				login: 'opencode',
				models: false,
				headers: (req) => ({ 'user-agent': 'hal', ...(req.sessionId && { 'x-opencode-session': req.sessionId }) }),
			},
			ollama: { baseUrl: 'http://localhost:11434/v1' },
		}
	},
}
