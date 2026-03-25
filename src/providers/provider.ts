// Provider loader — returns the right provider for a model, caching instances.
//
// Provider interface lives in protocol.ts. This file handles:
// 1. Mapping "provider/model-id" strings to concrete Provider implementations
// 2. Caching provider instances (one per provider name)
// 3. Shared utilities: retry delay parsing, stream read timeout

import type { Provider } from '../protocol.ts'

// ── Configuration ──

const config = {
	// Generous timeout: chunks normally arrive every ~100ms, but allows for slow starts
	streamTimeoutMs: 120_000,
}

// ── Provider cache ──
// Lazily instantiated providers keyed by provider name (e.g. "anthropic", "openai")

const cache = new Map<string, Provider>()

// Compat providers use Chat Completions API via openai-compat code path
const COMPAT_PROVIDERS = new Set(['openrouter', 'google', 'grok'])

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
	} else if (COMPAT_PROVIDERS.has(providerName)) {
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
				`Set ${envKey} for custom endpoints, or use: anthropic, openai, openrouter, google, grok`
			)
		}
	}

	cache.set(providerName, p)
	return p
}

// ── Shared utilities ──

/** Extract retry delay in ms from HTTP response headers or body. */
function parseRetryDelay(res: Response, body?: string): number | undefined {
	// Standard Retry-After header (seconds or HTTP date)
	const header = res.headers.get('retry-after')
	if (header) {
		const sec = Number(header)
		if (!isNaN(sec) && sec > 0) return Math.ceil(sec * 1000)
		const date = Date.parse(header)
		if (!isNaN(date)) return Math.max(1000, date - Date.now())
	}
	// Google-style retryDelay in JSON body details
	if (body) {
		try {
			let json = JSON.parse(body)
			if (Array.isArray(json)) json = json[0]
			const details = json?.error?.details ?? json?.details
			if (Array.isArray(details)) {
				for (const d of details) {
					const delay = d?.retryDelay
					if (typeof delay === 'string') {
						const m = delay.match(/^(\d+(?:\.\d+)?)s$/)
						if (m) return Math.ceil(Number(m[1]) * 1000)
					}
				}
			}
		} catch {}
	}
	return undefined
}

/** Race reader.read() against a timeout to detect network drops. */
async function readWithTimeout(
	reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<ReadableStreamReadResult<Uint8Array>> {
	let timer: Timer
	const timeout = new Promise<never>((_, reject) => {
		const ms = config.streamTimeoutMs
		timer = setTimeout(
			() => reject(new Error(`Stream read timed out (no data for ${ms}ms)`)),
			ms,
		)
	})
	try {
		return await Promise.race([reader.read(), timeout])
	} finally {
		clearTimeout(timer!)
	}
}

export const provider = { config, getProvider, parseRetryDelay, readWithTimeout }
