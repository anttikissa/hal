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
		const assistantMessages = apiMessages.toAnthropicMessages(sessionId)
		const assistant = assistantMessages.find((message) => message.role === 'assistant')!
		expect(Array.isArray(assistant.content)).toBe(true)
		expect(assistant.content).toEqual([
			{ type: 'thinking', thinking: 'hmm', signature: 'sig-123' },
			{ type: 'text', text: 'done' },
		])
		const history = sessions.loadHistory(sessionId)
		const entry = history.find((item) => item.role === 'assistant')!
		expect(entry.thinkingBlobId).toBe(thinkingEvent.blobId)
	} finally {
		providerLoader.getProvider = origGetProvider
		ipc.appendEvent = origAppendEvent
	}
})
