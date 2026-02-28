import { loadConfig } from '../config.ts'
import { OpenAICompletionsProvider } from './openai-completions.ts'

const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434/v1'

function ollamaBaseUrl(): string {
	const configured = loadConfig().ollamaBaseUrl?.trim()
	if (!configured) return DEFAULT_OLLAMA_BASE_URL
	const base = configured.replace(/\/+$/, '')
	if (base.endsWith('/v1')) return base
	return `${base}/v1`
}

export const ollamaProvider = new OpenAICompletionsProvider({
	name: 'ollama',
	baseUrl: ollamaBaseUrl,
})
