import { OpenAICompletionsProvider } from './openai-completions.ts'

const OLLAMA_BASE_URL = 'http://localhost:11434/v1'

export const ollamaProvider = new OpenAICompletionsProvider({
	name: 'ollama',
	baseUrl: OLLAMA_BASE_URL,
})
