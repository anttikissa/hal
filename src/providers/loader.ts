// Lazy-loads provider adapters on first use.

import type { Provider } from './provider.ts'

const cache = new Map<string, Provider>()

export async function loadProvider(name: string): Promise<Provider> {
	const cached = cache.get(name)
	if (cached) return cached
	const mod = await import(`./${name}-provider.ts`)
	const provider: Provider = mod.default ?? mod.provider
	cache.set(name, provider)
	return provider
}
