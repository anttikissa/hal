// Provider loader — returns the right provider for a model, caching instances.
//
// Provider interface lives in protocol.ts. This file handles:
// 1. Mapping "provider/model-id" strings to concrete Provider implementations
// 2. Caching provider instances (one per provider name)
//
// Shared streaming / retry helpers live in providers/shared.ts. Keeping them out
// of this loader avoids cycles where concrete providers import the loader while
// the loader dynamically imports those providers.

import type { Provider } from '../protocol.ts'
import { providerShared } from './shared.ts'

// ── Provider cache ──
// Lazily instantiated providers keyed by provider name (e.g. "anthropic", "openai")

const cache = new Map<string, Provider>()

/** Get (or lazily create) the provider for a given provider name. */
async function getProvider(providerName: string): Promise<Provider> {
	const cached = cache.get(providerName)
	if (cached) return cached

	let p: Provider
	if (providerName === 'anthropic') {
		const { anthropicProvider } = await import('./anthropic.ts')
		p = anthropicProvider
	} else if (providerName === 'openai') {
		const { openaiProvider } = await import('./openai.ts')
		p = openaiProvider
	} else if (Object.hasOwn(providerShared.compatEndpoints, providerName)) {
		const { createCompatProvider } = await import('./openai.ts')
		p = createCompatProvider(providerName)
	} else {
		// Unknown provider — try compat with a custom base URL from env
		// e.g. OLLAMA_BASE_URL=http://localhost:11434/v1
		const envKey = `${providerName.toUpperCase()}_BASE_URL`
		const baseUrl = process.env[envKey]
		if (baseUrl) {
			const { createCompatProvider } = await import('./openai.ts')
			p = createCompatProvider(providerName, baseUrl)
		} else {
			throw new Error(
				`Unknown provider '${providerName}'. ` +
					`Set ${envKey} for custom endpoints, or use: anthropic, openai, ${Object.keys(providerShared.compatEndpoints).join(', ')}`,
			)
		}
	}

	cache.set(providerName, p)
	return p
}

export const provider = { getProvider }
