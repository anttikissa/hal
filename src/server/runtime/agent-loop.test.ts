import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { agentLoop } from './agent-loop.ts'
import { provider as providerLoader } from '../providers/provider.ts'
import { ipc } from '../../ipc.ts'
import { sessions } from '../sessions.ts'
import { blob } from '../session/blob.ts'
import { apiMessages } from '../session/api-messages.ts'
import { tokenCalibration } from '../token-calibration.ts'
import { toolRegistry } from '../tools/tool.ts'
import { ason } from '../../utils/ason.ts'

const createdSessions: string[] = []

afterEach(() => {
	for (const sessionId of createdSessions.splice(0)) {
		rmSync(sessions.sessionDir(sessionId), { recursive: true, force: true })
	}
})

test('sanitizes redundant bash cd prefix before saving tool calls', () => {
	const input = { command: 'cd /tmp/../tmp && pwd', timeout: 1000 }
	expect(agentLoop.sanitizeToolCallInput('bash', input, '/tmp/')).toEqual({
		command: 'pwd',
		timeout: 1000,
		cwd: '/tmp/',
	})
	expect(agentLoop.sanitizeToolCallInput('bash', input, '/var')).toBe(input)
})

	test('settles unstarted tool calls when a batch is aborted', async () => {
		const sessionId = `test-aborted-tools-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
		createdSessions.push(sessionId)
		await sessions.createSession(sessionId, { id: sessionId, createdAt: new Date().toISOString(), workingDir: process.cwd() })
		const events: any[] = []
		const origAppendEvent = ipc.appendEvent
		const ac = new AbortController()
		ac.abort()
		ipc.appendEvent = (event: any) => { events.push(event) }
		try {
			const results = await agentLoop.executeToolBatch(sessionId, [
				{ id: 'tool-a', name: 'bash', input: { command: 'one' } },
				{ id: 'tool-b', name: 'eval', input: { code: 'two' } },
			], process.cwd(), ac.signal)
			expect(results).toEqual([
				{ call: { id: 'tool-a', name: 'bash', input: { command: 'one' } }, result: '[interrupted]', blobId: expect.any(String) },
				{ call: { id: 'tool-b', name: 'eval', input: { code: 'two' } }, result: '[interrupted]', blobId: expect.any(String) },
			])
			expect(events.filter((event) => event.type === 'tool-result' && event.phase === 'done').map((event) => event.toolId)).toEqual(['tool-a', 'tool-b'])
		} finally {
			ipc.appendEvent = origAppendEvent
		}
	})


test('abort before tool dispatch keeps the tool from starting', async () => {
	const sessionId = `test-abort-before-dispatch-${Date.now().toString(36)}`
	createdSessions.push(sessionId)
	await sessions.createSession(sessionId, { id: sessionId, createdAt: new Date().toISOString(), workingDir: process.cwd() })
	const origDispatch = toolRegistry.dispatch
	const ac = new AbortController()
	let dispatches = 0
	toolRegistry.dispatch = async () => {
		dispatches++
		return 'ran'
	}
	try {
		const batch = agentLoop.executeToolBatch(sessionId, [{ id: 'tool-a', name: 'read', input: { path: 'x' } }], process.cwd(), ac.signal)
		ac.abort()
		const results = await batch
		expect(dispatches).toBe(0)
		expect(results[0]?.result).toBe('[interrupted]')
	} finally {
		toolRegistry.dispatch = origDispatch
	}
})


	test('streams partial output for each concurrent tool call', async () => {
		const sessionId = `test-tool-output-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
		createdSessions.push(sessionId)
		await sessions.createSession(sessionId, { id: sessionId, createdAt: new Date().toISOString(), workingDir: process.cwd() })

		const events: any[] = []
		const origGetProvider = providerLoader.getProvider
		const origAppendEvent = ipc.appendEvent
		const origDispatch = toolRegistry.dispatch
		let generations = 0
		let releaseB: (() => void) | undefined
		const bStarted = Promise.withResolvers<void>()
		const aDone = Promise.withResolvers<void>()
		providerLoader.getProvider = async () => ({
			async *generate() {
				generations++
				if (generations === 1) {
					yield { type: 'tool_call', id: 'tool-a', name: 'bash', input: { command: 'printf a' } }
					yield { type: 'tool_call', id: 'tool-b', name: 'bash', input: { command: 'printf b' } }
				}
				yield { type: 'done', usage: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 } }
			},
		})
		ipc.appendEvent = (event: any) => {
			events.push(event)
			if (event.type === 'tool-result' && event.toolId === 'tool-a' && event.phase === 'done') aDone.resolve()
		}
		toolRegistry.dispatch = async (_name, input: any, context) => {
			context.onOutput?.(Array.from({ length: 30 }, (_, index) => `${input.command}: line ${index + 1} ${'x'.repeat(20)}`).join('\n'))
			if (input.command === 'printf b') {
				bStarted.resolve()
				await new Promise<void>((resolve) => { releaseB = resolve })
			}
			return `${input.command}: finished`
		}

		try {
			const loop = agentLoop.runAgentLoop({
				sessionId,
				model: 'openai/gpt-5.4',
				cwd: process.cwd(),
				systemPrompt: 'test prompt',
				messages: [{ role: 'user', content: 'run two commands' }],
			})
			await bStarted.promise
			const aFinishedBeforeB = await Promise.race([aDone.promise.then(() => true), Bun.sleep(100).then(() => false)])
			releaseB?.()
			expect(aFinishedBeforeB).toBe(true)
			await loop

			for (const toolId of ['tool-a', 'tool-b']) {
				const partial = events.findIndex((event) => event.type === 'tool-result' && event.toolId === toolId && event.phase === 'running')
				const done = events.findIndex((event) => event.type === 'tool-result' && event.toolId === toolId && event.phase === 'done')
				expect(partial).toBeGreaterThanOrEqual(0)
				expect(events[partial]!.output).toStartWith('[+14 earlier lines; showing last 16]\n')
				expect(Buffer.byteLength(events[partial]!.output, 'utf8')).toBeLessThanOrEqual(1024)
				expect(done).toBeGreaterThan(partial)
			}
		} finally {
			providerLoader.getProvider = origGetProvider
			ipc.appendEvent = origAppendEvent
			toolRegistry.dispatch = origDispatch
		}
	})

test('surfaces Claude web_search as a visible tool with result titles', async () => {
	const sessionId = `test-web-search-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
	createdSessions.push(sessionId)
	await sessions.createSession(sessionId, { id: sessionId, createdAt: new Date().toISOString(), workingDir: process.cwd() })

	const events: any[] = []
	const origGetProvider = providerLoader.getProvider
	const origAppendEvent = ipc.appendEvent
	providerLoader.getProvider = async () => ({
		async *generate() {
			yield { type: 'server_tool', serverBlocks: [{ type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'latest NASA news today' } }] }
			yield {
				type: 'server_tool',
				serverBlocks: [{
					type: 'web_search_tool_result',
					tool_use_id: 'srvtoolu_1',
					content: [
						{ type: 'web_search_result', title: 'NASA News', url: 'https://www.nasa.gov/news/' },
						{ type: 'web_search_result', title: 'NASA JPL', url: 'https://www.jpl.nasa.gov/' },
					],
				}],
			}
			yield { type: 'text', text: 'Found NASA news.' }
			yield { type: 'done', usage: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 } }
		},
	})
	ipc.appendEvent = (event: any) => {
		events.push(event)
	}

	try {
		const result = await agentLoop.runAgentLoop({
			sessionId,
			model: 'anthropic/claude-opus-4-8',
			cwd: process.cwd(),
			systemPrompt: 'test prompt',
			messages: [{ role: 'user', content: 'search' }],
		})
		expect(result).toBe('completed')
		expect(events.find((event) => event.type === 'info' && event.text?.includes('[web_search]'))).toBeUndefined()
		expect(events.find((event) => event.type === 'tool-call')).toMatchObject({ name: 'web_search', input: { query: 'latest NASA news today' } })
		const webSearchOutput = events.find((event) => event.type === 'tool-result')?.output
		expect(webSearchOutput).toContain('NASA News\nhttps://www.nasa.gov/news/')
		expect(webSearchOutput).toContain('\n\nNASA JPL\nhttps://www.jpl.nasa.gov/')
		expect(webSearchOutput).not.toContain('result')
		expect(webSearchOutput).not.toContain('- NASA')

		const history = sessions.loadHistory(sessionId)
		expect(history.find((entry) => entry.type === 'tool_call')).toMatchObject({ type: 'tool_call', name: 'web_search', visibility: 'ui' })
		expect(apiMessages.toProviderMessages(sessionId, history).some((message: any) => JSON.stringify(message).includes('web_search'))).toBe(false)
	} finally {
		providerLoader.getProvider = origGetProvider
		ipc.appendEvent = origAppendEvent
	}
})


test('calibrates context token estimates from provider input usage', async () => {
	const sessionId = `test-calibration-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
	const origGetProvider = providerLoader.getProvider
	const origStateDir = process.env.HAL_STATE_DIR
	const tempStateDir = mkdtempSync(join(tmpdir(), 'hal-agent-calibration-'))
	createdSessions.push(sessionId)
	process.env.HAL_STATE_DIR = tempStateDir
	await sessions.createSession(sessionId, { id: sessionId, createdAt: new Date().toISOString(), workingDir: process.cwd() })

	providerLoader.getProvider = async () => ({
		async *generate() {
			yield { type: 'text', text: 'done' }
			yield { type: 'done', usage: { input: 50, output: 1, cacheRead: 25, cacheCreation: 25 } }
		},
	})

	try {
		await agentLoop.runAgentLoop({
			sessionId,
			model: 'openai/gpt-calibration-loop',
			cwd: process.cwd(),
			systemPrompt: 'x'.repeat(80),
			messages: [{ role: 'user', content: 'x'.repeat(20) }],
		})

		const cal = tokenCalibration.get('openai/gpt-calibration-loop')
		expect(cal?.systemTokens).toBe(100)
		expect(cal?.systemBytes).toBeGreaterThan(100)
	} finally {
		providerLoader.getProvider = origGetProvider
		if (origStateDir === undefined) delete process.env.HAL_STATE_DIR
		else process.env.HAL_STATE_DIR = origStateDir
		rmSync(tempStateDir, { recursive: true, force: true })
	}
})


test('completed final response does not remain in live scratch state', async () => {
	const sessionId = `test-live-clear-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
	createdSessions.push(sessionId)
	await sessions.createSession(sessionId, { id: sessionId, createdAt: new Date().toISOString(), workingDir: process.cwd() })

	const origGetProvider = providerLoader.getProvider
	providerLoader.getProvider = async () => ({
		async *generate() {
			yield { type: 'text', text: 'done' }
			yield { type: 'done', usage: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 } }
		},
	})

	try {
		const result = await agentLoop.runAgentLoop({
			sessionId,
			model: 'openai/gpt-5.4',
			cwd: process.cwd(),
			systemPrompt: 'test prompt',
			messages: [],
		})
		expect(result).toBe('completed')
		expect(sessions.loadHistory(sessionId).find((item) => item.type === 'assistant')?.text).toBe('done')
		expect(sessions.loadLive(sessionId).blocks).toEqual([])
	} finally {
		providerLoader.getProvider = origGetProvider
	}
})

test('logs an empty completed provider response so the user can retry', async () => {
	const sessionId = `test-empty-response-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
	createdSessions.push(sessionId)
	await sessions.createSession(sessionId, { id: sessionId, createdAt: new Date().toISOString(), workingDir: process.cwd() })

	const events: any[] = []
	const origGetProvider = providerLoader.getProvider
	const origAppendEvent = ipc.appendEvent
	providerLoader.getProvider = async () => ({
		async *generate() {
			yield { type: 'done', usage: { input: 1, output: 4, cacheRead: 0, cacheCreation: 0 } }
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
			messages: [{ role: 'user', content: 'answer me' }],
		})
		expect(result).toBe('completed')
		expect(events).toContainEqual(expect.objectContaining({
			type: 'info',
			text: 'Provider returned an empty response. Please retry.',
		}))
		expect(sessions.loadHistory(sessionId)).toContainEqual(expect.objectContaining({
			type: 'log',
			text: 'Provider returned an empty response. Please retry.',
		}))
		expect(sessions.loadHistory(sessionId).at(-1)).toMatchObject({ type: 'turn_end', status: 'completed' })
	} finally {
		providerLoader.getProvider = origGetProvider
		ipc.appendEvent = origAppendEvent
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
		expect(history.find((item) => item.type === 'turn_end')).toMatchObject({ type: 'turn_end', status: 'completed', usage: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 } })
	} finally {
		providerLoader.getProvider = origGetProvider
		ipc.appendEvent = origAppendEvent
	}
})


test('provider errors show their full ASON payload and save it in a blob', async () => {
	const sessionId = `test-error-blob-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
	createdSessions.push(sessionId)
	await sessions.createSession(sessionId, { id: sessionId, createdAt: new Date().toISOString(), workingDir: process.cwd() })

	const events: any[] = []
	const origGetProvider = providerLoader.getProvider
	const origAppendEvent = ipc.appendEvent
	const payload = {
		type: 'error',
		error: { type: 'not_found_error', message: 'model: claude-mythos-5' },
		request_id: 'req_011Cdxix8LyGnHX6ucNx3eip',
	}

	providerLoader.getProvider = async () => ({
		async *generate() {
			yield {
				type: 'error',
				message: 'Anthropic API 404',
				status: 404,
				endpoint: 'https://api.anthropic.com/v1/messages?beta=true',
				body: JSON.stringify(payload),
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
			text: `404: (https://api.anthropic.com/v1/messages?beta=true)\n${ason.stringify(payload)}`,
		})
		expect(responseEvent.blobId).toBeTruthy()
		const streamEnd = events.find((event) => event.type === 'stream-end')
		expect(streamEnd).toMatchObject({ phase: 'failed' })
		expect(blob.readBlob(sessionId, responseEvent.blobId)).toMatchObject({
			type: 'provider_error',
			message: 'Anthropic API 404',
			status: 404,
			endpoint: 'https://api.anthropic.com/v1/messages?beta=true',
			payload,
		})
		const history = sessions.loadHistory(sessionId)
		expect(history.at(-2)).toMatchObject({
			type: 'error',
			text: `404: (https://api.anthropic.com/v1/messages?beta=true)\n${ason.stringify(payload)}`,
		})
		expect(history.at(-1)).toMatchObject({ type: 'turn_end', status: 'failed' })
		expect(sessions.loadLive(sessionId).blocks).toEqual([])
	} finally {
		providerLoader.getProvider = origGetProvider
		ipc.appendEvent = origAppendEvent
	}
})


test('context length errors warn when local model limit looked safe', async () => {
	const sessionId = `test-context-warning-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
	createdSessions.push(sessionId)
	await sessions.createSession(sessionId, { id: sessionId, createdAt: new Date().toISOString(), workingDir: process.cwd() })

	const events: any[] = []
	const origGetProvider = providerLoader.getProvider
	const origAppendEvent = ipc.appendEvent

	providerLoader.getProvider = async () => ({
		async *generate() {
			yield {
				type: 'error',
				message: 'Your input exceeds the context window of this model.',
				body: JSON.stringify({ error: { code: 'context_length_exceeded' } }),
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
			messages: [{ role: 'user', content: 'short' }],
		})

		const warning = events.find((event) => event.type === 'info' && event.level === 'error' && event.text.includes('Provider rejected the request for context length'))
		expect(warning?.text).toContain('Local estimate')
		expect(warning?.text).toContain('models.ason')
	} finally {
		providerLoader.getProvider = origGetProvider
		ipc.appendEvent = origAppendEvent
	}
})


test('session working state updates at turn start and end', async () => {
	const sessionId = `test-status-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
	createdSessions.push(sessionId)
	await sessions.createSession(sessionId, { id: sessionId, createdAt: new Date().toISOString(), workingDir: process.cwd() })

	const statuses: boolean[] = []
	const origGetProvider = providerLoader.getProvider

	providerLoader.getProvider = async () => ({
		async *generate() {
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
			onStatus: async (working) => {
				statuses.push(working)
			},
		})
		expect(statuses).toEqual([true, false])
	} finally {
		providerLoader.getProvider = origGetProvider
	}
})


test('displaced generation cannot clear newer working request state', async () => {
	const sessionId = `test-displace-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
	createdSessions.push(sessionId)
	await sessions.createSession(sessionId, { id: sessionId, createdAt: new Date().toISOString(), workingDir: process.cwd() })

	let firstSignal: AbortSignal | undefined
	const firstStarted = Promise.withResolvers<void>()
	const releaseFirst = Promise.withResolvers<void>()
	const secondStarted = Promise.withResolvers<void>()
	const finishSecond = Promise.withResolvers<void>()
	let calls = 0
	const origGetProvider = providerLoader.getProvider

	providerLoader.getProvider = async () => ({
		async *generate({ signal }: any) {
			calls++
			if (calls === 1) {
				firstSignal = signal
				firstStarted.resolve()
				await releaseFirst.promise
				yield { type: 'done' }
				return
			}
			secondStarted.resolve()
			await finishSecond.promise
			yield { type: 'done' }
		},
	})

	try {
		const first = agentLoop.runAgentLoop({
			sessionId,
			model: 'openai/gpt-5.4',
			cwd: process.cwd(),
			systemPrompt: 'test prompt',
			messages: [],
		})
		await firstStarted.promise

		const second = agentLoop.runAgentLoop({
			sessionId,
			model: 'openai/gpt-5.4',
			cwd: process.cwd(),
			systemPrompt: 'test prompt',
			messages: [],
		})
		await secondStarted.promise
		expect(firstSignal?.aborted).toBe(true)

		releaseFirst.resolve()
		expect(await first).toBe('aborted')
		expect(agentLoop.isWorking(sessionId)).toBe(true)

		finishSecond.resolve()
		expect(await second).toBe('completed')
		expect(agentLoop.isWorking(sessionId)).toBe(false)
	} finally {
		providerLoader.getProvider = origGetProvider
		agentLoop.state.workingRequests.delete(sessionId)
		agentLoop.state.abortTexts.clear()
	}
})

test('abortAndWait resolves only after its generation finishes', async () => {
	const sessionId = `test-abort-wait-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
	createdSessions.push(sessionId)
	await sessions.createSession(sessionId, { id: sessionId, createdAt: new Date().toISOString(), workingDir: process.cwd() })

	const started = Promise.withResolvers<void>()
	const release = Promise.withResolvers<void>()
	const origGetProvider = providerLoader.getProvider
	providerLoader.getProvider = async () => ({
		async *generate() {
			started.resolve()
			await release.promise
			yield { type: 'done' }
		},
	})

	try {
		const turn = agentLoop.runAgentLoop({
			sessionId,
			model: 'openai/gpt-5.4',
			cwd: process.cwd(),
			systemPrompt: 'test prompt',
			messages: [],
		})
		await started.promise

		const settled = agentLoop.abortAndWait(sessionId, '')
		expect(settled).not.toBe(false)
		let didSettle = false
		void (settled as Promise<void>).then(() => { didSettle = true })
		await Bun.sleep(0)
		expect(didSettle).toBe(false)

		release.resolve()
		expect(await turn).toBe('aborted')
		await settled
		expect(didSettle).toBe(true)
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
	let workingUpdates = 0

	providerLoader.getProvider = async () => ({
		async *generate() {
			yield { type: 'tool_call', id: 'tool-1', name: 'read', input: { path: 'src/server/runtime/agent-loop.test.ts', start: 1, end: 1 } }
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
			onStatus: async (working) => {
				if (!working) return
				workingUpdates++
				if (workingUpdates === 3) ac.abort()
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

test('pause before all tools in batch persists pending marker without executing tools', async () => {
	const sessionId = `test-pending-tools-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
	createdSessions.push(sessionId)
	await sessions.createSession(sessionId, { id: sessionId, createdAt: new Date().toISOString(), workingDir: process.cwd() })

	const events: any[] = []
	const origGetProvider = providerLoader.getProvider
	const origAppendEvent = ipc.appendEvent
	const origDispatch = toolRegistry.dispatch
	let dispatched = false

	providerLoader.getProvider = async () => ({
		async *generate() {
			expect(agentLoop.requestPauseBeforeTools(sessionId)).toBe(true)
			yield { type: 'text', text: 'checking' }
			yield { type: 'tool_call', id: 'tool-1', name: 'read', input: { path: 'README.md' } }
			yield { type: 'done', usage: { input: 2, output: 3, cacheRead: 0, cacheCreation: 0 } }
		},
	})
	ipc.appendEvent = (event: any) => { events.push(event) }
	toolRegistry.dispatch = async () => {
		dispatched = true
		return 'should not run'
	}

	try {
		const result = await agentLoop.runAgentLoop({
			sessionId,
			model: 'openai/gpt-5.4',
			cwd: process.cwd(),
			systemPrompt: 'test prompt',
			messages: [{ role: 'user', content: 'use tool' }],
		})

		const history = sessions.loadHistory(sessionId)
		expect(result).toBe('paused')
		expect(dispatched).toBe(false)
		expect(history).toMatchObject([
			{ type: 'assistant', text: 'checking' },
			{ type: 'tool_call', toolId: 'tool-1', name: 'read' },
			{ type: 'pending_tools', toolIds: ['tool-1'], reason: 'soft-pause', usage: { input: 2, output: 3, cacheRead: 0, cacheCreation: 0 } },
		])
		expect(history.some((entry) => entry.type === 'tool_result')).toBe(false)
		expect(history.some((entry) => entry.type === 'turn_end')).toBe(false)
		expect(events).toContainEqual(expect.objectContaining({ type: 'info', text: '[paused before local tools]' }))
	} finally {
		providerLoader.getProvider = origGetProvider
		ipc.appendEvent = origAppendEvent
		toolRegistry.dispatch = origDispatch
		agentLoop.clearPauseBeforeTools(sessionId)
	}
})


test('max iterations persists a continuable error without ending the turn', async () => {
	const sessionId = `test-max-iterations-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
	createdSessions.push(sessionId)
	await sessions.createSession(sessionId, { id: sessionId, createdAt: new Date().toISOString(), workingDir: process.cwd() })

	const events: any[] = []
	const origGetProvider = providerLoader.getProvider
	const origAppendEvent = ipc.appendEvent
	const origMaxIterations = agentLoop.config.maxIterations

	providerLoader.getProvider = async () => ({
		async *generate() {
			yield { type: 'tool_call', id: 'tool-1', name: 'read', input: { path: 'src/server/runtime/agent-loop.test.ts', start: 1, end: 1 } }
			yield { type: 'done', usage: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 } }
		},
	})
	ipc.appendEvent = (event: any) => {
		events.push(event)
	}
	agentLoop.config.maxIterations = 1

	try {
		const result = await agentLoop.runAgentLoop({
			sessionId,
			model: 'openai/gpt-5.4',
			cwd: process.cwd(),
			systemPrompt: 'test prompt',
			messages: [],
		})
		const history = sessions.loadHistory(sessionId)
		expect(result).toBe('paused')
		expect(events).toContainEqual(expect.objectContaining({ type: 'info', text: 'Hit max iterations (1). Stopping.', level: 'error' }))
		expect(events).toContainEqual(expect.objectContaining({ type: 'stream-end', phase: 'done' }))
		expect(history.at(-1)).toMatchObject({ type: 'error', text: 'Hit max iterations (1). Stopping.' })
		expect(history.some((entry) => entry.type === 'turn_end')).toBe(false)
	} finally {
		providerLoader.getProvider = origGetProvider
		ipc.appendEvent = origAppendEvent
		agentLoop.config.maxIterations = origMaxIterations
	}
})


test('custom abort text is persisted', async () => {
	const sessionId = `test-custom-abort-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
	createdSessions.push(sessionId)
	await sessions.createSession(sessionId, { id: sessionId, createdAt: new Date().toISOString(), workingDir: process.cwd() })

	const events: any[] = []
	const origGetProvider = providerLoader.getProvider
	const origAppendEvent = ipc.appendEvent

	providerLoader.getProvider = async () => ({
		async *generate() {
			setTimeout(() => agentLoop.abort(sessionId, 'Tab closed'), 10)
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
		})
		expect(events.some((event) => event.type === 'info' && event.text === 'Tab closed')).toBe(true)
		expect(events.some((event) => event.type === 'info' && event.text === '[paused]')).toBe(false)
		expect(sessions.loadHistory(sessionId).at(-1)).toMatchObject({ type: 'turn_end', status: 'aborted', abortText: 'Tab closed' })
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

	providerLoader.getProvider = async () => ({
		async *generate() {
			setTimeout(() => agentLoop.abort(sessionId, ''), 10)
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
		})
		expect(events.some((event) => event.type === 'info' && (event.text === '[paused]' || event.text === '' || event.text === '[restarted]'))).toBe(false)
		const streamEnd = events.find((event) => event.type === 'stream-end')
		expect(streamEnd).toBeTruthy()
		expect(sessions.loadHistory(sessionId).at(-1)).toMatchObject({ type: 'turn_end', status: 'aborted', abortText: '' })
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

	providerLoader.getProvider = async () => ({
		async *generate() {
			setTimeout(() => ac.abort(), 10)
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
		})
		const elapsedMs = Date.now() - startedAt
		expect(elapsedMs).toBeLessThan(1_000)
		expect(events.some((event) => event.type === 'info' && event.text === '[paused]')).toBe(true)
	} finally {
		providerLoader.getProvider = origGetProvider
		ipc.appendEvent = origAppendEvent
	}
})
