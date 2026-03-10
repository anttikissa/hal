// Provider interface — adapters implement this.

export type ProviderEvent =
	| { type: 'thinking'; text: string }
	| { type: 'thinking_signature'; signature: string }
	| { type: 'text'; text: string }
	| { type: 'tool_call'; id: string; name: string; input: unknown }
	| { type: 'done'; usage?: { input: number; output: number } }
	| { type: 'error'; message: string; status?: number; body?: string }

export interface GenerateParams {
	messages: any[]
	model: string
	systemPrompt: string
	tools?: any[]
	signal?: AbortSignal
	sessionId?: string
}

export interface Provider {
	name: string
	generate(params: GenerateParams): AsyncGenerator<ProviderEvent>
}

const STREAM_TIMEOUT_MS = 30_000

/** Race reader.read() against a timeout. Throws if no data arrives within 30s. */
export async function readWithTimeout(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<ReadableStreamReadResult<Uint8Array>> {
	let timer: Timer
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error('Stream read timed out (no data for 30s)')), STREAM_TIMEOUT_MS)
	})
	try {
		return await Promise.race([reader.read(), timeout])
	} finally {
		clearTimeout(timer!)
	}
}
