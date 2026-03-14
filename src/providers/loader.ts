// Lazy-loads provider adapters on first use.

import type { Provider } from './provider.ts'

const COMPAT_PROVIDERS = new Set(['openrouter', 'gemini', 'grok'])

const cache = new Map<string, Provider>()

export async function loadProvider(name: string): Promise<Provider> {
	const cached = cache.get(name)
	if (cached) return cached

	let provider: Provider
	if (COMPAT_PROVIDERS.has(name)) {
		const { createOpenAICompatProvider } = await import('./openai-compat.ts')
		provider = createOpenAICompatProvider(name)
	} else {
		const mod = await import(`./${name}.ts`)
		provider = mod.default ?? mod.provider
	}

	cache.set(name, provider)
	return provider
}

export const loader = { loadProvider }
