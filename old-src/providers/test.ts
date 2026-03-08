/**
 * Test provider — returns canned responses, no network calls.
 * Registered under anthropic/openai/ollama in --test mode to intercept live API calls.
 */
import { Provider } from '../provider.ts'

class TestProvider extends Provider {
	name: string

	constructor(name: string) {
		super()
		this.name = name
	}

	async fetch(_body: any, _signal?: AbortSignal) {
		// Tests that don't send prompts never reach here.
		return new Response('test provider: no real API', { status: 500 })
	}

	buildRequestBody(params: any) {
		return params
	}

	async complete({ userMessage }: any) {
		return { text: `[test] echo: ${userMessage.slice(0, 200)}` }
	}
}

export const testAnthropicProvider = new TestProvider('anthropic')
export const testOpenaiProvider = new TestProvider('openai')
export const testOllamaProvider = new TestProvider('ollama')
