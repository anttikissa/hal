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
			yield { type: 'done', usage: { input: 1, output: 1 } }
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
		})
		const thinkingEvent = events.find((event) => event.type === 'stream-delta' && event.channel === 'thinking')
		const assistantMessages = apiMessages.toProviderMessages(sessionId)
		const assistant = assistantMessages.find((message) => message.role === 'assistant')!
		expect(Array.isArray(assistant.content)).toBe(true)
		expect(assistant.content).toEqual([
			{ type: 'thinking', thinking: 'hmm', signature: 'sig-123' },
			{ type: 'text', text: 'done' },
		])
		const history = sessions.loadHistory(sessionId)
		expect(history.find((item) => item.type === 'thinking')?.blobId).toBe(thinkingEvent.blobId)
		expect(history.find((item) => item.type === 'assistant')?.text).toBe('done')
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
			yield { type: 'done', usage: { input: 0, output: 0 } }
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
			yield { type: 'done', usage: { input: 1, output: 1 } }
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
			signal: ac.signal,
			onStatus: async (_busy, activity) => {
				if (activity?.startsWith('running ')) sawToolRun = true
				if (activity === 'generating...' && sawToolRun) ac.abort()
			},
		})
		expect(events.some((event) => event.type === 'info' && event.text === 'Hit max iterations (50). Stopping.')).toBe(false)
		expect(events.some((event) => event.type === 'info' && event.text === '[paused]')).toBe(true)
	} finally {
		providerLoader.getProvider = origGetProvider
		ipc.appendEvent = origAppendEvent
	}
})
