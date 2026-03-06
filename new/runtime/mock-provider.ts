// Mock provider — simulates streaming responses for development.

import type { Provider, ProviderEvent, GenerateParams } from './provider.ts'

function sleep(ms: number): Promise<void> {
	return new Promise(r => setTimeout(r, ms))
}

async function* generate(params: GenerateParams): AsyncGenerator<ProviderEvent> {
	const lastUser = [...params.messages].reverse().find((m: any) => m.role === 'user')
	const prompt = typeof lastUser?.content === 'string' ? lastUser.content : 'hello'

	// Thinking phase
	yield { type: 'thinking', text: 'Let me think about this...' }
	await sleep(200)
	yield { type: 'thinking', text: '\n\nAnalyzing the input.' }
	await sleep(200)

	// Response
	const words = prompt.split(/\s+/)
	const response = `You said "${prompt}" (${words.length} word${words.length === 1 ? '' : 's'}).`
	for (const ch of response) {
		yield { type: 'text', text: ch }
		await sleep(15)
	}

	yield { type: 'done', usage: { input: prompt.length, output: response.length } }
}

const provider: Provider = { name: 'mock', generate }
export default provider
