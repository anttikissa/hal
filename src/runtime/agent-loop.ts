import { writeFile, appendFile } from 'fs/promises'
import {
	providerForModel,
	modelIdForModel,
	debugEnabled,
} from '../config.ts'
import { RESPONSE_LOG } from '../state.ts'
import { getProvider, type Provider } from '../provider.ts'
import { tools, runTool, RESTART_SIGNAL } from '../tools.ts'
import { contextStatus, saveCalibration, shouldWarn } from '../context.ts'
import { saveSession } from '../session.ts'
import { stringify } from '../utils/ason.ts'
import {
	getSessionWorkingDir,
	getSessionModel,
	busySessions,
	emitStatus,
	calibrated,
	setCalibrated,
	type SessionRuntimeCache,
} from './sessions.ts'
import { publishLine, publishChunk, publishActivity } from './event-publisher.ts'

const REQ_LOG = '/tmp/hal-req.ason'

export async function runAgentLoop(sessionId: string, runtime: SessionRuntimeCache): Promise<void> {
	busySessions.add(sessionId)
	runtime.pausedByUser = false
	await emitStatus(true)

	const fullModel = getSessionModel(sessionId)
	const modelId = modelIdForModel(fullModel)
	const provider = getProvider(providerForModel(fullModel))

	let done = false
	while (!done && !runtime.pausedByUser) {
		runtime.activeAbort = new AbortController()

		const messages = sanitizeMessages(provider, runtime.messages)
		const cachedMessages = provider.addCacheBreakpoints(messages)
		const body = provider.buildRequestBody({
			model: modelId,
			messages: cachedMessages,
			system: runtime.systemPrompt,
			tools,
			maxTokens: 16000,
			sessionId,
		})
		await writeFile(REQ_LOG, stringify(body) + '\n').catch(() => {})

		await publishActivity('Sending request...', sessionId)
		const res = await fetchWithRetry(sessionId, runtime, provider, body)
		if (!res || runtime.pausedByUser) break

		const parsed = await parseResponseStream(sessionId, runtime, provider, res)
		if (!parsed) break

		if (debugEnabled('responseLogging')) {
			const entry = {
				ts: new Date().toISOString(),
				sessionId,
				stopReason: parsed.stopReason,
				usage: parsed.usage,
				blocks: parsed.contentBlocks.length,
			}
			await appendFile(RESPONSE_LOG, stringify(entry) + '\n').catch(() => {})
		}

		if (Object.keys(parsed.usage).length > 0) {
			await logTokenUsage(sessionId, runtime, provider, parsed.usage)
		}

		if (runtime.pausedByUser || parsed.aborted) {
			const cleanBlocks = parsed.contentBlocks.filter((b: any) => {
				if (!b) return false
				if (b.type === 'tool_use' && typeof b.input === 'string') return false
				// Drop thinking blocks without signatures (incomplete due to pause/abort)
				if (b.type === 'thinking' && !b.signature) return false
				return true
			})
			if (cleanBlocks.length > 0) {
				runtime.messages.push({ role: 'assistant', content: cleanBlocks })
				const toolBlocks = cleanBlocks.filter((b: any) => b.type === 'tool_use')
				if (toolBlocks.length > 0) {
					runtime.messages.push({
						role: 'user',
						content: toolBlocks.map((b: any) => ({
							type: 'tool_result',
							tool_use_id: b.id,
							content: '[interrupted by user pause]',
						})),
					})
				}
			}
			runtime.messages.push({
				role: 'user',
				content: '[User paused generation. Waiting for next direction.]',
			})
			break
		}

		const validBlocks = parsed.contentBlocks.filter(
			(b: any) =>
				b &&
				!(b.type === 'text' && !b.text?.trim()) &&
				!(b.type === 'thinking' && !b.thinking?.trim()),
		)
		runtime.messages.push({ role: 'assistant', content: validBlocks })

		const hasToolUse = parsed.contentBlocks.some((b: any) => b?.type === 'tool_use')
		done = parsed.stopReason === 'end_turn' || (!hasToolUse && parsed.stopReason !== 'tool_use')

		const toolBlocks = parsed.contentBlocks.filter((b: any) => b?.type === 'tool_use')
		if (runtime.pausedByUser) {
			for (const block of toolBlocks) {
				runtime.messages.push(
					provider.toolResultMessage(block.id, '[interrupted by user pause]'),
				)
			}
			done = true
			break
		}

		if (toolBlocks.length > 0) {
			const toolResults = await Promise.all(
				toolBlocks.map(async (block: any) => {
					await publishActivity(`Running: ${block.name}`, sessionId)
					const output = await runTool(block.name, block.input, {
						logger: (line, level = 'tool') => publishLine(line, level, sessionId),
						cwd: getSessionWorkingDir(sessionId),
						signal: runtime.activeAbort?.signal,
					})
					return { id: block.id, output }
				}),
			)

			let shouldRestart = false
			for (const result of toolResults) {
				if (result.output === RESTART_SIGNAL) {
					runtime.messages.push(provider.toolResultMessage(result.id, 'Restarting now.'))
					shouldRestart = true
					continue
				}
				if (runtime.pausedByUser) {
					runtime.messages.push(
						provider.toolResultMessage(
							result.id,
							`${result.output}\n[interrupted by user pause]`,
						),
					)
					done = true
				} else {
					runtime.messages.push(provider.toolResultMessage(result.id, result.output))
					done = false
				}
			}

			if (shouldRestart) {
				await saveSession(sessionId, runtime.messages, runtime.tokenTotals)
				process.exit(100)
			}
		}
	}

	runtime.activeAbort = null
	busySessions.delete(sessionId)
	await emitStatus(true)

	await saveSession(sessionId, runtime.messages, runtime.tokenTotals)

	if (runtime.lastUsage && shouldWarn(runtime.lastUsage)) {
		await publishLine(
			'[context] >66% full. /handoff to produce handoff file and continue, or /reset to start afresh.',
			'warn',
			sessionId,
		)
	}
}

// Sanitize: drop empty blocks, fix orphaned tool_use, strip server_tool_use artifacts
function sanitizeMessages(provider: Provider, messages: any[]): any[] {
	const sanitized = messages
		.map((m) => {
			if (!Array.isArray(m.content)) return m
			const filtered = m.content
				.filter((b: any) => {
					if (!b) return false
					if (b.type === 'text' && !b.text?.trim()) return false
					if (b.type === 'thinking' && !b.thinking?.trim()) return false
					if (
						provider.name === 'anthropic' &&
						b.type === 'thinking' &&
						!String(b.signature ?? '').trim()
					)
						return false
					if (
						b.type === 'tool_result' &&
						typeof b.tool_use_id === 'string' &&
						b.tool_use_id.startsWith('srvtoolu_')
					)
						return false
					return true
				})
				.map((b: any) => {
					if (b.type === 'server_tool_use' && '__inputJson' in b) {
						const { __inputJson, ...clean } = b
						return clean
					}
					return b
				})
			return { ...m, content: filtered }
		})
		.filter((m) => !Array.isArray(m.content) || m.content.length > 0)

	// Fix orphaned tool_use: ensure every tool_use has a matching tool_result
	const fixed: typeof sanitized = []
	for (let i = 0; i < sanitized.length; i++) {
		fixed.push(sanitized[i])
		const msg = sanitized[i]
		if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue

		const toolUseIds = msg.content
			.filter((b: any) => b.type === 'tool_use')
			.map((b: any) => b.id)
		if (toolUseIds.length === 0) continue

		const resultIds = new Set<string>()
		for (let j = i + 1; j < sanitized.length; j++) {
			if (sanitized[j].role !== 'user') break
			if (Array.isArray(sanitized[j].content)) {
				for (const b of sanitized[j].content) {
					if (b.type === 'tool_result') resultIds.add(b.tool_use_id)
				}
			}
		}

		const missing = toolUseIds.filter((id: string) => !resultIds.has(id))
		if (missing.length > 0) {
			fixed.push({
				role: 'user',
				content: missing.map((id: string) => ({
					type: 'tool_result',
					tool_use_id: id,
					content: '[interrupted — no result available]',
				})),
			})
		}
	}
	return fixed
}

async function fetchWithRetry(
	sessionId: string,
	runtime: SessionRuntimeCache,
	provider: Provider,
	body: any,
): Promise<Response | null> {
	const MAX_RETRIES = 5

	for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
		if (runtime.pausedByUser) return null

		let res: Response
		try {
			res = await provider.fetch(body, runtime.activeAbort?.signal)
		} catch (e: any) {
			if (runtime.pausedByUser) return null
			if (attempt < MAX_RETRIES - 1) {
				const delay = Math.min(2000 * Math.pow(2, attempt), 30000)
				await publishActivity(`Retrying (${attempt + 1}/${MAX_RETRIES})...`, sessionId)
				await publishLine(
					`[retry] network error: ${e.message}. retrying in ${(delay / 1000).toFixed(0)}s... (${attempt + 1}/${MAX_RETRIES})`,
					'warn',
					sessionId,
				)
				await Bun.sleep(delay)
				continue
			}
			throw e
		}

		if (res.ok && res.body) return res

		const status = res.status
		const retryable = status === 429 || status === 529 || status === 503 || status >= 500
		const data = (await res.json().catch(() => ({}))) as any

		if (!retryable || attempt >= MAX_RETRIES - 1) {
			await publishLine(
				`[error] ${status}: ${data.error?.message ?? stringify(data)}`,
				'error',
				sessionId,
			)
			await publishLine(
				'hint: you can re-send your message, or use /reset to start fresh',
				'warn',
				sessionId,
			)
			return null
		}

		const retryAfterMs = res.headers.get('retry-after-ms')
		const retryAfter = res.headers.get('retry-after')
		let delay: number
		if (retryAfterMs) delay = parseInt(retryAfterMs, 10)
		else if (retryAfter) delay = parseInt(retryAfter, 10) * 1000
		else delay = Math.min(2000 * Math.pow(2, attempt), 30000)
		delay = Math.max(delay, 500)

		await publishLine(
			`[retry] ${status}: ${data.error?.message ?? 'server error'}. retrying in ${(delay / 1000).toFixed(1)}s... (${attempt + 1}/${MAX_RETRIES})`,
			'warn',
			sessionId,
		)
		await Bun.sleep(delay)
	}

	return null
}

async function parseResponseStream(
	sessionId: string,
	runtime: SessionRuntimeCache,
	provider: Provider,
	res: Response,
): Promise<{
	contentBlocks: any[]
	stopReason: string | null
	usage: any
	aborted: boolean
} | null> {
	const contentBlocks: any[] = []
	runtime.streamingBlocks = contentBlocks
	let stopReason: string | null = null
	const usage: any = {}
	let aborted = false

	const reader = res.body!.getReader()
	const decoder = new TextDecoder()
	let buffer = ''

	while (true) {
		if (runtime.pausedByUser) {
			aborted = true
			try {
				await reader.cancel()
			} catch {}
			break
		}

		let readResult: any
		try {
			readResult = await reader.read()
		} catch {
			aborted = runtime.pausedByUser
			break
		}

		const { done, value } = readResult
		if (done) break
		buffer += decoder.decode(value, { stream: true })

		let boundary: number
		while ((boundary = buffer.indexOf('\n\n')) !== -1) {
			const chunk = buffer.slice(0, boundary)
			buffer = buffer.slice(boundary + 2)

			let eventType = ''
			let eventData = ''
			for (const line of chunk.split('\n')) {
				if (line.startsWith('event: ')) eventType = line.slice(7).trim()
				if (line.startsWith('data: ')) eventData += line.slice(6)
			}
			if (!eventData) continue

			const events = provider.parseSSE({ type: eventType, data: eventData })
			for (const evt of events) {
				switch (evt.type) {
					case 'activity':
						if (evt.text.trim()) await publishActivity(evt.text, sessionId)
						break
					case 'text_start':
						contentBlocks[evt.index] = { type: 'text', text: '' }
						await publishActivity('Writing...', sessionId)
						break
					case 'text_delta':
						if (evt.text && contentBlocks[evt.index]) {
							contentBlocks[evt.index].text += evt.text
							await publishChunk(evt.text, 'assistant', sessionId)
						}
						break
					case 'thinking_start':
						contentBlocks[evt.index] = { type: 'thinking', thinking: '' }
						await publishActivity('Thinking...', sessionId)
						break
					case 'thinking_delta':
						if (evt.text && contentBlocks[evt.index]) {
							contentBlocks[evt.index].thinking += evt.text
							await publishChunk(evt.text, 'thinking', sessionId)
						}
						break
					case 'signature_delta':
						if (contentBlocks[evt.index]?.type === 'thinking') {
							contentBlocks[evt.index].signature =
								(contentBlocks[evt.index].signature ?? '') + evt.signature
						}
						break
					case 'tool_use_start':
						contentBlocks[evt.index] = {
							type: 'tool_use',
							id: evt.id,
							name: evt.name,
							input: '',
						}
						await publishActivity(`Calling tool: ${evt.name}`, sessionId)
						break
					case 'tool_input_delta':
						if (contentBlocks[evt.index]?.type === 'tool_use') {
							contentBlocks[evt.index].input += evt.json
						} else if (contentBlocks[evt.index]?.type === 'server_tool_use') {
							const block = contentBlocks[evt.index] as any
							block.__inputJson = (block.__inputJson ?? '') + evt.json
							try {
								block.input = JSON.parse(block.__inputJson)
							} catch {}
						}
						break
					case 'raw_block':
						contentBlocks[evt.index] = evt.block
						break
					case 'block_stop': {
						const block = contentBlocks[evt.index]
						if (
							block?.type === 'server_tool_use' &&
							typeof block.__inputJson === 'string'
						) {
							try {
								block.input = JSON.parse(block.__inputJson)
							} catch {}
							delete block.__inputJson
						}
						if (block?.type === 'server_tool_use' && block?.name === 'web_search') {
							await publishLine(
								`[web_search] ${stringify(block.input ?? {})}`,
								'tool',
								sessionId,
							)
						}
						if (
							block?.type === 'thinking' &&
							block.thinking?.trim() &&
							!block.thinking.endsWith('\n')
						)
							await publishChunk('\n', 'thinking', sessionId)
						if (
							block?.type === 'text' &&
							block.text?.trim() &&
							!block.text.endsWith('\n')
						)
							await publishChunk('\n', 'assistant', sessionId)

						break
					}
					case 'web_search':
						await publishLine(`[web_search] "${evt.query}"`, 'tool', sessionId)
						break
					case 'web_search_results':
						if (evt.results) await publishLine(evt.results, 'tool', sessionId)
						break
					case 'usage':
						Object.assign(usage, evt.usage)
						break
					case 'stop':
						stopReason = evt.stopReason
						await publishActivity('', sessionId)
						break
					case 'error':
						await publishActivity(`Error: ${evt.message}`, sessionId)
						await publishLine(`[stream error] ${evt.message}`, 'error', sessionId)
						await publishLine(
							'hint: you can re-send your message, or use /reset to start fresh',
							'warn',
							sessionId,
						)
						break
				}
			}
		}
	}

	provider.finalizeBlocks(contentBlocks)
	runtime.streamingBlocks = null
	return { contentBlocks, stopReason, usage, aborted }
}

function messageBytes(msg: any): number {
	if (typeof msg.content === 'string') return msg.content.length
	if (Array.isArray(msg.content)) {
		let bytes = 0
		for (const block of msg.content) {
			if (block.type === 'text') bytes += block.text?.length ?? 0
			else if (block.type === 'thinking') bytes += block.thinking?.length ?? 0
			else if (block.type === 'tool_use') bytes += JSON.stringify(block.input ?? {}).length
			else if (block.type === 'tool_result')
				bytes +=
					typeof block.content === 'string'
						? block.content.length
						: JSON.stringify(block.content ?? '').length
		}
		return bytes
	}
	return 0
}

async function logTokenUsage(
	sessionId: string,
	runtime: SessionRuntimeCache,
	provider: Provider,
	usage: any,
): Promise<void> {
	runtime.lastUsage = usage
	const normalized = provider.normalizeUsage(usage)
	const { input, output, cacheCreate, cacheRead } = normalized

	runtime.tokenTotals.input += input
	runtime.tokenTotals.output += output
	runtime.tokenTotals.cacheCreate += cacheCreate
	runtime.tokenTotals.cacheRead += cacheRead

	// Calibrate bytes->tokens ratio on first API response and log system prompt size
	const totalInput = input + cacheCreate + cacheRead
	if (!calibrated()) {
		setCalibrated()
		if (totalInput > 0 && runtime.systemBytes > 0) {
			let msgBytes = 0
			for (const msg of runtime.messages) msgBytes += messageBytes(msg)
			const totalBytes = runtime.systemBytes + msgBytes
			await saveCalibration(totalBytes, totalInput)
			if (debugEnabled('tokens')) {
				await publishLine(
					`[system] prompt + tools + first message = ${totalInput} tokens`,
					'status',
					sessionId,
				)
			}
		}
	}

	const parts = [`in: ${totalInput}`]
	if (cacheRead || cacheCreate) {
		parts[0] += ` (${input} new`
		if (cacheCreate) parts[0] += ` + ${cacheCreate} cache_write`
		if (cacheRead) parts[0] += ` + ${cacheRead} cached`
		parts[0] += ')'
	}
	parts.push(`out: ${output}`)

	const totalAllInput =
		runtime.tokenTotals.input + runtime.tokenTotals.cacheCreate + runtime.tokenTotals.cacheRead
	const effectiveCost =
		runtime.tokenTotals.input +
		runtime.tokenTotals.cacheCreate * 1.25 +
		runtime.tokenTotals.cacheRead * 0.1
	const savings = totalAllInput > 0 ? ((1 - effectiveCost / totalAllInput) * 100).toFixed(0) : '0'

	let totalPart = `total in: ${totalAllInput}`
	if (runtime.tokenTotals.cacheRead > 0) totalPart += ` (${savings}% saved by cache)`
	totalPart += ` out: ${runtime.tokenTotals.output}`
	parts.push(totalPart)

	await publishLine(`[tokens] ${parts.join(' | ')}`, 'status', sessionId)
	await publishLine(contextStatus(usage, runtime.messages), 'status', sessionId)
}
