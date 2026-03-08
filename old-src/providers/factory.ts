import { getConfig, type ProviderConfig } from '../config.ts'
import { registerProvider } from '../provider.ts'
import { OpenAICompletionsProvider } from './openai-completions.ts'

function normalizeBaseUrl(baseUrl: string): string {
	return baseUrl.replace(/\/+$/, '')
}

function headerMap(config: ProviderConfig): Record<string, string> {
	if (!config.headers || typeof config.headers !== 'object') return {}
	return Object.fromEntries(
		Object.entries(config.headers).filter(
			([k, v]) => typeof k === 'string' && k.length > 0 && typeof v === 'string',
		),
	)
}

function createProvider(name: string, config: ProviderConfig): OpenAICompletionsProvider | null {
	if (config.protocol !== 'openai-completions') return null
	if (!config.baseUrl || typeof config.baseUrl !== 'string') return null
	return new OpenAICompletionsProvider({
		name,
		baseUrl: normalizeBaseUrl(config.baseUrl),
		providerAuthName: (config.auth ?? 'apiKey') === 'none' ? undefined : name,
		headers: headerMap(config),
		maxTokensField: config.maxTokensField,
		includeUsageInStream: config.includeUsageInStream,
	})
}

export function registerConfigProviders(): void {
	const providers = getConfig().providers
	if (!providers || typeof providers !== 'object') return
	for (const [name, config] of Object.entries(providers)) {
		if (!name || typeof config !== 'object' || !config) continue
		const provider = createProvider(name, config as ProviderConfig)
		if (!provider) continue
		registerProvider(provider)
	}
}
