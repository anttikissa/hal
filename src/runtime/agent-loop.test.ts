import { afterEach, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { agentLoop } from './agent-loop.ts'
import { provider as providerLoader } from '../providers/provider.ts'
import { ipc } from '../ipc.ts'
import { sessions } from '../server/sessions.ts'
import { blob } from '../session/blob.ts'
import { apiMessages } from '../session/api-messages.ts'

const createdSessions: string[] = []

afterEach(() => {
	for (const sessionId of createdSessions.splice(0)) {
		rmSync(sessions.sessionDir(sessionId), { recursive: true, force: true })
	}
})

test('writes thinking blobs while streaming and replays them into API history', async () => {
	const sessionId = `test-thinking-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
	createdSessions.push(sessionId)
	await sessions.createSession(sessionId, { id: sessionId, createdAt: new Date().toISOString(), workingDir: process.cwd() })

	const events: any[] = []
	const origGetProvider = providerLoader.getProvider
	const origAppendEvent = ipc.appendEvent

	providerLoader.getProvider = async () => ({
		async *generate() {
			yield { type: 'thinking', text: 'hmm' }
			const thinkingEvent = events.find((event) => event.type === 'stream-delta' && event.channel === 'thinking')
			expect(thinkingEvent?.blobId).toBeTruthy()
			expect(blob.readBlob(sessionId, thinkingEvent.blobId)?.thinking).toBe('hmm')

			yield { type: 'thinking_signature', signature: 'sig-123' }
			expect(blob.readBlob(sessionId, thinkingEvent.blobId)?.signature).toBe('sig-123')

			yield { type: 'text', text: 'done' }
			yield { type: 'done', usage: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 } }
		},
	})
	ipc.appendEvent = (event: any) => {
		events.push(event)
	}

	try {
		const result = await agentLoop.runAgentLoop({
			sessionId,
			model: 'openai/gpt-5.4',
			cwd: process.cwd(),
			systemPrompt: 'test prompt',
			messages: [],
		})
		expect(result).toBe('completed')
		const thinkingEvent = events.find((event) => event.type === 'stream-delta' && event.channel === 'thinking')
		const assistantMessages = apiMessages.toProviderMessages(sessionId)
		const assistant = assistantMessages.find((message) => message.role === 'assistant')!
		expect(Array.isArray(assistant.content)).toBe(true)
		expect(assistant.content).toEqual([
			{ type: 'thinking', thinking: 'hmm', signature: 'sig-123' },
			{ type: 'text', text: 'done' },
		])
		const history = sessions.loadHistory(sessionId)
		const thinkingEntry = history.find((item) => item.type === 'thinking')
		expect(thinkingEntry).toMatchObject({ type: 'thinking', blobId: thinkingEvent.blobId })
		expect(thinkingEntry && 'signature' in thinkingEntry ? (thinkingEntry as any).signature : undefined).toBeUndefined()
		expect(thinkingEntry && 'text' in thinkingEntry ? (thinkingEntry as any).text : undefined).toBeUndefined()
		expect(history.find((item) => item.type === 'assistant')?.text).toBe('done')
	} finally {
		providerLoader.getProvider = origGetProvider
		ipc.appendEvent = origAppendEvent
	}
})


test('provider errors save full payload in a blob but show only the short message', async () => {
	const sessionId = `test-error-blob-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
	createdSessions.push(sessionId)
	await sessions.createSession(sessionId, { id: sessionId, createdAt: new Date().toISOString(), workingDir: process.cwd() })

	const events: any[] = []
	const origGetProvider = providerLoader.getProvider
	const origAppendEvent = ipc.appendEvent

	providerLoader.getProvider = async () => ({
		async *generate() {
			yield {
				type: 'error',
				message: 'Our servers are currently overloaded. Please try again later.',
				status: 400,
				endpoint: 'https://api.example.test/v1/responses',
				body: JSON.stringify({
					type: 'response.failed',
					response: {
						status: 'failed',
						error: {
							code: 'server_is_overloaded',
							message: 'Our servers are currently overloaded. Please try again later.',
						},
						instructions: '# SYSTEM.md\nvery long prompt here',
					},
				}),
			}
			yield { type: 'done' }
		},
	})
	ipc.appendEvent = (event: any) => {
		events.push(event)
	}

	try {
		const result = await agentLoop.runAgentLoop({
			sessionId,
			model: 'openai/gpt-5.4',
			cwd: process.cwd(),
			systemPrompt: 'test prompt',
			messages: [],
		})
		expect(result).toBe('failed')
		const responseEvent = events.find((event) => event.type === 'response' && event.isError)
		expect(responseEvent).toMatchObject({
			type: 'response',
			isError: true,
			text: '400: (https://api.example.test/v1/responses)\nOur servers are currently overloaded. Please try again later.',
		})
		expect(responseEvent.text).not.toContain('instructions')
		expect(responseEvent.text).not.toContain('response.failed')
		expect(responseEvent.blobId).toBeTruthy()
		expect(blob.readBlob(sessionId, responseEvent.blobId)).toMatchObject({
			type: 'provider_error',
			message: 'Our servers are currently overloaded. Please try again later.',
			status: 400,
			endpoint: 'https://api.example.test/v1/responses',
			payload: {
				type: 'response.failed',
				response: {
					status: 'failed',
					error: {
						code: 'server_is_overloaded',
					},
				},
			},
		})
	} finally {
		providerLoader.getProvider = origGetProvider
		ipc.appendEvent = origAppendEvent
	}
})


test('provider status updates busy activity', async () => {
	const sessionId = `test-status-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
	createdSessions.push(sessionId)
	await sessions.createSession(sessionId, { id: sessionId, createdAt: new Date().toISOString(), workingDir: process.cwd() })

	const statuses: Array<{ busy: boolean; activity?: string }> = []
	const origGetProvider = providerLoader.getProvider

	providerLoader.getProvider = async () => ({
		async *generate() {
			yield { type: 'status', activity: 'OpenAI 2/3 · next@test.com' }
			yield { type: 'done', usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 } }
		},
	})

	try {
		await agentLoop.runAgentLoop({
			sessionId,
			model: 'openai/gpt-5.4',
			cwd: process.cwd(),
			systemPrompt: 'test prompt',
			messages: [],
			onStatus: async (busy, activity) => {
				statuses.push({ busy, activity })
			},
		})
		expect(statuses).toContainEqual({ busy: true, activity: 'generating...' })
		expect(statuses).toContainEqual({ busy: true, activity: 'OpenAI 2/3 · next@test.com' })
		expect(statuses.at(-1)).toEqual({ busy: false, activity: undefined })
	} finally {
		providerLoader.getProvider = origGetProvider
	}
})


test('abort between tool iterations does not report max iterations', async () => {
	const sessionId = `test-abort-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
	createdSessions.push(sessionId)
	await sessions.createSession(sessionId, { id: sessionId, createdAt: new Date().toISOString(), workingDir: process.cwd() })

	const events: any[] = []
	const origGetProvider = providerLoader.getProvider
	const origAppendEvent = ipc.appendEvent
	const ac = new AbortController()
	let sawToolRun = false

	providerLoader.getProvider = async () => ({
		async *generate() {
			yield { type: 'tool_call', id: 'tool-1', name: 'read', input: { path: 'src/runtime/agent-loop.test.ts', start: 1, end: 1 } }
			yield { type: 'done', usage: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 } }
		},
	})
	ipc.appendEvent = (event: any) => {
		events.push(event)
	}

	try {
		const result = await agentLoop.runAgentLoop({
			sessionId,
			model: 'openai/gpt-5.4',
			cwd: process.cwd(),
			systemPrompt: 'test prompt',
			messages: [],
			signal: ac.signal,
			onStatus: async (_busy, activity) => {
				if (activity?.startsWith('running ')) sawToolRun = true
				if (activity === 'generating...' && sawToolRun) ac.abort()
			},
		})
		expect(result).toBe('aborted')
		expect(events.some((event) => event.type === 'info' && event.text === 'Hit max iterations (50). Stopping.')).toBe(false)
		expect(events.some((event) => event.type === 'info' && event.text === '[paused]')).toBe(true)
	} finally {
		providerLoader.getProvider = origGetProvider
		ipc.appendEvent = origAppendEvent
	}
})


test('custom abort text is persisted', async () => {
	const sessionId = `test-custom-abort-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
	createdSessions.push(sessionId)
	await sessions.createSession(sessionId, { id: sessionId, createdAt: new Date().toISOString(), workingDir: process.cwd() })

	const events: any[] = []
	const origGetProvider = providerLoader.getProvider
	const origAppendEvent = ipc.appendEvent
	let abortScheduled = false

	providerLoader.getProvider = async () => ({
		async *generate() {
			yield {
				type: 'error',
				message: 'rate limited',
				status: 429,
				retryAfterMs: 60_000,
			}
			yield { type: 'done' }
		},
	})
	ipc.appendEvent = (event: any) => {
		events.push(event)
	}

	try {
		await agentLoop.runAgentLoop({
			sessionId,
			model: 'openai/gpt-5.4',
			cwd: process.cwd(),
			systemPrompt: 'test prompt',
			messages: [],
			onStatus: async (_busy, activity) => {
				if (!abortScheduled && activity?.startsWith('rate limited — retrying in ')) {
					abortScheduled = true
					setTimeout(() => agentLoop.abort(sessionId, 'Tab closed'), 10)
				}
			},
		})
		expect(events.some((event) => event.type === 'info' && event.text === 'Tab closed')).toBe(true)
		expect(events.some((event) => event.type === 'info' && event.text === '[paused]')).toBe(false)
	} finally {
		providerLoader.getProvider = origGetProvider
		ipc.appendEvent = origAppendEvent
	}
})


test('empty abort text stops generation without adding an info block', async () => {
	const sessionId = `test-silent-abort-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
	createdSessions.push(sessionId)
	await sessions.createSession(sessionId, { id: sessionId, createdAt: new Date().toISOString(), workingDir: process.cwd() })

	const events: any[] = []
	const origGetProvider = providerLoader.getProvider
	const origAppendEvent = ipc.appendEvent
	let abortScheduled = false

	providerLoader.getProvider = async () => ({
		async *generate() {
			yield {
				type: 'error',
				message: 'rate limited',
				status: 429,
				retryAfterMs: 60_000,
			}
			yield { type: 'done' }
		},
	})
	ipc.appendEvent = (event: any) => {
		events.push(event)
	}

	try {
		await agentLoop.runAgentLoop({
			sessionId,
			model: 'openai/gpt-5.4',
			cwd: process.cwd(),
			systemPrompt: 'test prompt',
			messages: [],
			onStatus: async (_busy, activity) => {
				if (!abortScheduled && activity?.startsWith('rate limited — retrying in ')) {
					abortScheduled = true
					setTimeout(() => agentLoop.abort(sessionId, ''), 10)
				}
			},
		})
		expect(events.some((event) => event.type === 'info' && (event.text === '[paused]' || event.text === '' || event.text === '[restarted]'))).toBe(false)
		const streamEnd = events.find((event) => event.type === 'stream-end')
		expect(streamEnd).toBeTruthy()
	} finally {
		providerLoader.getProvider = origGetProvider
		ipc.appendEvent = origAppendEvent
	}
})


test('abort during rate-limit backoff stops immediately', async () => {
	const sessionId = `test-rate-limit-abort-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
	createdSessions.push(sessionId)
	await sessions.createSession(sessionId, { id: sessionId, createdAt: new Date().toISOString(), workingDir: process.cwd() })

	const events: any[] = []
	const origGetProvider = providerLoader.getProvider
	const origAppendEvent = ipc.appendEvent
	const ac = new AbortController()
	let abortScheduled = false

	providerLoader.getProvider = async () => ({
		async *generate() {
			yield {
				type: 'error',
				message: 'rate limited',
				status: 429,
				retryAfterMs: 60_000,
			}
			yield { type: 'done' }
		},
	})
	ipc.appendEvent = (event: any) => {
		events.push(event)
	}

	const startedAt = Date.now()
	try {
		await agentLoop.runAgentLoop({
			sessionId,
			model: 'openai/gpt-5.4',
			cwd: process.cwd(),
			systemPrompt: 'test prompt',
			messages: [],
			signal: ac.signal,
			onStatus: async (_busy, activity) => {
				if (!abortScheduled && activity?.startsWith('rate limited — retrying in ')) {
					abortScheduled = true
					setTimeout(() => ac.abort(), 10)
				}
			},
		})
		const elapsedMs = Date.now() - startedAt
		expect(elapsedMs).toBeLessThan(1_000)
		expect(events.some((event) => event.type === 'info' && event.text === '[paused]')).toBe(true)
	} finally {
		providerLoader.getProvider = origGetProvider
		ipc.appendEvent = origAppendEvent
	}
})
