// Agent loop — the core generation cycle.
//
// Drives a provider to generate responses, handles streaming, tool execution,
// and the re-invoke loop (generate → tool_use → tool_result → generate).
//
// Provider interface is defined in protocol.ts. Provider implementations
// are loaded lazily via providers/provider.ts.

import { ipc } from '../file-ipc.ts'
import { protocol } from '../../common/protocol.ts'
import type { ProviderStreamEvent, Message, TokenUsage, TurnEndMeta } from '../../common/protocol.ts'
import type { SharedSessionInfo } from '../../common/ipc.ts'
import { sessionLabel } from '../../common/session-label.ts'
import { models } from '../../common/models.ts'
import type { LiveEvent } from '../../common/live-event-blocks.ts'
import { context } from './system-prompt.ts'
import { provider as providerLoader } from '../providers/provider.ts'
import { toolRegistry, type ToolOutput } from '../tools/tool.ts'
import { bash } from '../tools/bash.ts'
import { risk, type RiskFinding } from '../tools/risk.ts'
import { sessions } from '../sessions.ts'
import { accounting } from '../session/accounting.ts'
import { blob } from '../session/blob.ts'
import { log } from '../../utils/log.ts'
import { ason } from '../../utils/ason.ts'
import { helpers } from '../../utils/helpers.ts'
import { tokenCalibration } from '../token-calibration.ts'
// Built-in tool registration now happens via explicit startup init.
// Anthropic also has its own server-side web_search tool
// (type: 'web_search_20250305'). That's separate from our local google tool.

// ── Configuration ──

const config = {
	/** Maximum tool→generate cycles before we force-stop. */
	maxIterations: 200,
	/** Max concurrent tool executions per cycle. */
	maxToolConcurrency: 5,
	/** Retry config for transient API errors. */
	retryBaseDelayMs: 5_000,
	retryMaxTotalMs: 2 * 60 * 60 * 1000, // 2 hours
	retryableStatuses: [429, 500, 503, 529],
	/** Max lines of provider error payload shown in the UI; the rest stays in the blob. */
	maxErrorDetailLines: 20,
}
type SettledRequest = {
	promise: Promise<void>
	resolve: () => void
}

function makeSettledRequest(): SettledRequest {
	let resolve: () => void = () => {}
	const promise = new Promise<void>((done) => { resolve = done })
	return { promise, resolve }
}

// ── State ──

const state = {
	/** In-progress turn abort controllers, keyed by session ID. */
	workingRequests: new Map<string, AbortController>(),
	/** Completion signals for individual turns, including turns superseded in the map. */
	settledRequests: new Map<AbortController, SettledRequest>(),
	/** Info text to emit when a particular aborted turn finishes unwinding. */
	abortTexts: new Map<AbortController, string>(),
	/** Soft pause requests that stop at the next local tool batch boundary. */
	pauseBeforeTools: new Set<string>(),
}

function runningSubagents(parentSessionId: string): SharedSessionInfo[] {
	const shared = ipc.readState()
	const active: SharedSessionInfo[] = []
	for (const [sessionId, working] of Object.entries(shared.working)) {
		if (!working) continue
		const meta = sessions.loadSessionMeta(sessionId)
		if (meta?.parentSessionId !== parentSessionId) continue
		if (meta.spawnKind !== 'subagent' && meta.spawnKind !== 'subagent-leave-open') continue
		active.push(shared.sessions.find((session) => session.id === sessionId) ?? { id: sessionId, cwd: '' })
	}
	return active
}

function runningSubagentNotice(parentSessionId: string): string {
	const active = runningSubagents(parentSessionId)
	if (active.length === 0) return ''
	return `<meta>Subagents running: ${active.map(sessionLabel.format).join(', ')}</meta>`
}


const DEFAULT_ABORT_TEXT = '[paused]'

function parseResetsInSeconds(body: string | undefined): number | undefined {
	if (!body) return undefined
	try {
		const json = JSON.parse(body)
		const secs = json?.error?.resets_in_seconds ?? json?.resets_in_seconds
		return typeof secs === 'number' && secs > 0 ? secs * 1000 : undefined
	} catch {
		return undefined
	}
}

// ── Types ──

export interface AgentContext {
	sessionId: string
	model: string // full "provider/model-id" string
	cwd: string
	/** Pre-built system prompt text. */
	systemPrompt: string
	/** Conversation messages so far (mutated as generation proceeds). */
	messages: Message[]
	/** Abort signal — user can ctrl-c to cancel. */
	signal?: AbortSignal
	/** Callback for session-level working state updates. */
	onStatus?: (working: boolean) => void | Promise<void>
	/** Applies persistent config controls emitted by HAL's internal provider. */
	onConfig?: (key: string, value: string) => void
}

export type AgentLoopResult = 'completed' | 'waiting' | 'aborted' | 'failed' | 'paused'

interface ToolCall {
	id: string
	name: string
	input: any
}

// ── IPC helpers ──

function emitEvent(sessionId: string, event: LiveEvent): void {
	const fullEvent = {
		id: protocol.eventId(),
		sessionId,
		createdAt: new Date().toISOString(),
		...event,
	}
	sessions.applyLiveEvent(sessionId, fullEvent)
	ipc.appendEvent(fullEvent)
}

function emitInfo(sessionId: string, text: string, level: 'info' | 'error' = 'info'): void {
	emitEvent(sessionId, { type: 'info', text, level })
}


function toolOutputPreview(output: ToolOutput): string {
	output = toolRegistry.outputText(output)
	const limit = 1024
	const suffix = '\n[… output continues; preview limited]'
	if (Buffer.byteLength(output, 'utf8') <= limit) return output

	const lines = output.split('\n')
	const trailingNewline = lines.at(-1) === ''
	if (trailingNewline) lines.pop()
	if (lines.length <= 16) return helpers.truncateUtf8(output, limit, suffix)

	const omitted = lines.length - 16
	let tail = lines.slice(-16).join('\n')
	if (trailingNewline) tail += '\n'
	return helpers.truncateUtf8(`[+${omitted} earlier lines; showing last 16]\n${tail}`, limit, suffix)
}

async function writeThinkingBlob(sessionId: string, blobId: string, thinkingText: string, thinkingSignature?: string): Promise<void> {
	await blob.writeBlob(sessionId, blobId, {
		thinking: thinkingText,
		signature: thinkingSignature,
	})
}

async function writeToolCallBlob(sessionId: string, blobId: string, name: string, input: any): Promise<void> {
	const existing = blob.readBlob(sessionId, blobId) ?? {}
	existing.call = { name, input }
	await blob.writeBlob(sessionId, blobId, existing)
}

async function writeToolResultBlob(sessionId: string, blobId: string, output: ToolOutput): Promise<void> {
	const existing = blob.readBlob(sessionId, blobId) ?? {}
	existing.result = { content: output, status: 'done' }
	await blob.writeBlob(sessionId, blobId, existing)
}

function webSearchInput(block: any): { query: string } {
	return { query: typeof block?.input?.query === 'string' ? block.input.query : '' }
}

function formatWebSearchResults(block: any): string {
	const content = Array.isArray(block?.content) ? block.content : []
	const parts: string[] = []
	for (const item of content) {
		if (item?.type !== 'web_search_result') continue
		const lines: string[] = []
		if (typeof item.title === 'string' && item.title) lines.push(item.title)
		if (typeof item.url === 'string' && item.url) lines.push(item.url)
		if (lines.length) parts.push(lines.join('\n'))
	}
	return parts.join('\n\n') || 'No results found.'
}

function sanitizeToolCallInput(name: string, input: any, cwd: string): any {
	if (name !== 'bash' || input == null || typeof input !== 'object') return input
	const command = bash.stripCdCwd(input.command, cwd)
	if (command === input.command) return input
	return { ...input, command, cwd }
}

function toolQuestionText(call: ToolCall, findings: RiskFinding[]): string {
	const reasons = findings.map((finding) => finding.reason).join('; ')
	return `Allow risky ${call.name} tool call? ${reasons}`
}

function riskyToolCalls(toolCalls: ToolCall[]): Array<{ call: ToolCall; findings: RiskFinding[] }> {
	const risky: Array<{ call: ToolCall; findings: RiskFinding[] }> = []
	for (const call of toolCalls) {
		const findings = risk.analyzeToolCall(call.name, call.input)
		if (findings.length > 0) risky.push({ call, findings })
	}
	return risky
}

function parseErrorPayload(body: string | undefined): unknown {
	if (!body) return undefined
	try {
		return JSON.parse(body)
	} catch {
		return body
	}
}

function isContextLengthError(event: ProviderStreamEvent): boolean {
	const haystack = [event.message, event.body]
		.filter(Boolean)
		.join('\n')
		.toLowerCase()
	return (
		haystack.includes('context_length_exceeded') ||
		haystack.includes('context window') ||
		haystack.includes('context length')
	)
}

function formatContextLengthWarning(messages: Message[], model: string, overheadBytes: number): string | null {
	const est = context.estimateContext(messages, model, overheadBytes)
	if (est.used >= est.max) return null
	return [
		"Provider rejected the request for context length, but Hal's local estimate was still below the model limit.",
		`Local estimate: ${est.used}/${est.max} tokens.`,
		'Provider APIs report token usage after successful calls, but do not report a reliable "context remaining" value on this error; models.ason or token calibration may be optimistic.',
	].join(' ')
}

// True iff any token class is non-zero. A fully-cached turn has input = 0 but
// non-zero cacheRead, so we can't just check `input > 0`.
function hasUsage(u: TokenUsage): boolean {
	return u.input > 0 || u.output > 0 || u.cacheRead > 0 || u.cacheCreation > 0
}

function usageOrUndefined(usage: TokenUsage): TokenUsage | undefined {
	return hasUsage(usage) ? usage : undefined
}

function appendTurnEnd(sessionId: string, meta: TurnEndMeta): void {
	sessions.appendHistory(sessionId, [{ type: 'turn_end', ts: new Date().toISOString(), ...meta }])
}

function errorHistoryEntry(text: string, blobId?: string, ts = new Date().toISOString()): any {
	const entry: any = { type: 'error', text, ts }
	if (blobId) entry.blobId = blobId
	return entry
}

function requestBytes(messages: Message[], overheadBytes: number): number {
	let total = Math.max(0, overheadBytes)
	for (const msg of messages) total += context.messageBytes(msg)
	return total
}

function calibrateInputTokens(model: string, messages: Message[], overheadBytes: number, usage: TokenUsage): void {
	const totalInput = usage.input + usage.cacheRead + usage.cacheCreation
	if (totalInput <= 0) return
	tokenCalibration.save(requestBytes(messages, overheadBytes), totalInput, model)
}

async function writeErrorBlob(sessionId: string, blobId: string, event: ProviderStreamEvent): Promise<void> {
	await blob.writeBlob(sessionId, blobId, {
		type: 'provider_error',
		message: event.message,
		status: event.status,
		endpoint: event.endpoint,
		retryAfterMs: event.retryAfterMs,
		payload: parseErrorPayload(event.body),
	})
}

// ── Retry logic ──

function computeRetryDelay(retryAfterMs: number | undefined, attempt: number): number {
	// If server says when to retry, use that. Otherwise exponential backoff: 5s, 10s, 20s, 40s, 80s, 160s, ...
	// No cap — if the API is down for an hour, we wait. Max total time (2h) is the only limit.
	const base = retryAfterMs ?? config.retryBaseDelayMs * Math.pow(2, attempt)
	const jitterRange = attempt === 0 ? 1000 : attempt === 1 ? 2000 : 5000
	const jitter = (Math.random() * 2 - 1) * jitterRange
	return Math.max(1000, Math.round(base + jitter))
}

function isRetryableStatus(status: number | undefined): boolean {
	return status != null && config.retryableStatuses.includes(status)
}

/**
 * Build the user-visible API error below the status/endpoint header.
 *
 * Some providers echo the whole request back in their error payload (OpenAI's
 * failed responses include the system prompt), so cap what we print. The full
 * payload always stays in the error blob.
 */
function formatErrorDetails(event: ProviderStreamEvent, blobRef: string): string {
	const payload = parseErrorPayload(event.body)
	let text = 'Unknown error'
	if (payload && typeof payload === 'object') text = ason.stringify(payload)
	else if (typeof event.message === 'string' && event.message.trim()) text = event.message.trim()
	const lines = text.split('\n')
	if (lines.length <= config.maxErrorDetailLines) return text
	return [...lines.slice(0, config.maxErrorDetailLines), `[… ${lines.length - config.maxErrorDetailLines} more lines — read_blob ${blobRef}]`].join('\n')
}

/**
 * Sleep for a retry delay, but wake up early when the generation is aborted.
 *
 * This matters for provider switches: changing away from a rate-limited model
 * should cancel the old wait immediately instead of leaving the session stuck
 * in a long backoff.
 */
async function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return
	await new Promise<void>((resolve) => {
		const timer = setTimeout(done, ms)
		function done(): void {
			clearTimeout(timer)
			signal.removeEventListener('abort', done)
			resolve()
		}
		signal.addEventListener('abort', done, { once: true })
	})
}

// ── Tool execution ──
// Dispatches tool calls through the tool registry. Built-in tool registration
// now happens explicitly during startup.

// ── The main loop ──

async function runAgentLoop(ctx: AgentContext): Promise<AgentLoopResult> {
	const { sessionId, model, systemPrompt, messages, signal } = ctx

	// Parse "provider/model-id" — e.g. "anthropic/claude-opus-4-6". A bare name that
	// resolveModel could not expand is a model Hal has never heard of, so say that
	// rather than inventing a provider name and failing inside the provider loader.
	const slashIdx = model.indexOf('/')
	if (slashIdx < 0) throw new Error(`Model not found: ${model}. Run /model to list models, or /check to refresh Hal's model metadata.`)
	const providerName = model.slice(0, slashIdx)
	const modelId = model.slice(slashIdx + 1)
	const providerPromise = providerLoader.getProvider(providerName)

	// Abort any existing generation for this session. This prevents two
	// concurrent generations on the same session (race between client
	// sending 'prompt' and receiving the 'status: working' event).
	const existing = state.workingRequests.get(sessionId)
	if (existing) {
		log.info('Aborting existing generation (displaced by new one)', { sessionId })
		existing.abort()
	}

	// Register abort controller so external code can abort us.
	const ac = new AbortController()
	state.workingRequests.set(sessionId, ac)
	state.settledRequests.set(ac, makeSettledRequest())

	// If caller passed a signal, propagate its abort to our controller.
	if (signal) {
		if (signal.aborted) {
			log.info('Agent loop skipped (signal already aborted)', { sessionId })
			ac.abort(signal.reason)
		} else {
			signal.addEventListener('abort', () => {
				log.info('Agent loop abort via parent signal', { sessionId })
				ac.abort(signal.reason)
			}, { once: true })
		}
	}

	const loopSignal = ac.signal

	// Get tool definitions from the registry for the provider API
	const tools = toolRegistry.toToolDefs()

	const overheadBytes = systemPrompt.length + JSON.stringify(tools).length
	await ctx.onStatus?.(true)

	const meter = accounting.start(model, 'turn')
	try {
		const provider = await providerPromise
		const totalUsage = meter.usage
		let lastDoneMeta: TurnEndMeta | null = null
		let retryAttempt = 0
		let retryStartedAt = 0
		let hadTerminalError = false
		let terminalErrorStatus: number | undefined

		async function finishAborted(): Promise<void> {
			const signalText = typeof loopSignal.reason === 'string' ? loopSignal.reason : DEFAULT_ABORT_TEXT
			const abortText = state.abortTexts.has(ac) ? (state.abortTexts.get(ac) ?? '') : signalText
			if (abortText) emitInfo(sessionId, abortText)
			const est = context.estimateContext(messages, model, overheadBytes)
			emitEvent(sessionId, {
				type: 'stream-end',
				phase: 'done',
				usage: hasUsage(totalUsage) ? totalUsage : undefined,
				contextUsed: est.used,
				contextMax: est.max,
			})
			// Persist context so it survives restarts.
			void sessions.updateMeta(sessionId, { context: { used: est.used, max: est.max } })
			appendTurnEnd(sessionId, { status: 'aborted', abortText })
		}

		// Outer loop: each iteration is one generate call.
		// We loop when the model returns tool_use blocks.
		for (let iteration = 0; iteration < config.maxIterations; iteration++) {
			if (loopSignal.aborted) break

			// Count logical provider calls, including retries whose usage may be unknown.
			meter.requests++
			const gen = provider.generate({
				messages,
				model: modelId,
				systemPrompt,
				tools,
				signal: loopSignal,
				sessionId,
			})

			let assistantText = ''
			let thinkingText = ''
			let thinkingSignature = ''
			let thinkingBlobId = ''
			let thinkingEffort = models.reasoningEffort(model)
			const toolBlobMap = new Map<string, string>()
			const toolCalls: ToolCall[] = []
			// Server-side tool blocks (e.g. web_search) — opaque, go into assistant content verbatim
			const serverBlocks: any[] = []
			const serverToolHistory: any[] = []
			const serverToolBlobMap = new Map<string, string>()
			let aborted = false
			let shouldRetry = false
			let iterationDone = false
			let providerPaused = false
			let terminalErrorEntry: any | null = null



			try {
				for await (const event of gen) {
					if (loopSignal.aborted) {
						aborted = true
						break
					}

					switch (event.type) {
					case 'thinking': {
						if (!event.text) break
						if (!thinkingBlobId) thinkingBlobId = blob.makeBlobId(sessionId)
						thinkingText += event.text
						await writeThinkingBlob(sessionId, thinkingBlobId, thinkingText, thinkingSignature || undefined)
						emitEvent(sessionId, {
							type: 'stream-delta',
							text: event.text,
							channel: 'thinking',
							model,
							thinkingEffort,
							blobId: thinkingBlobId,
						})
						break
					}

					case 'thinking_signature':
						thinkingSignature = event.signature ?? ''
						if (thinkingBlobId) {
							await writeThinkingBlob(sessionId, thinkingBlobId, thinkingText, thinkingSignature || undefined)
						}
						break

						case 'text':
							assistantText += event.text ?? ''
						emitEvent(sessionId, {
							type: 'stream-delta',
							text: event.text,
							channel: 'assistant',
							model,
						})
							break

					case 'tool_call': {
						const tc = {
							id: event.id!,
							name: event.name!,
							input: sanitizeToolCallInput(event.name!, event.input, ctx.cwd),
						}
						toolCalls.push(tc)
						const blobId = toolBlobMap.get(tc.id) ?? blob.makeBlobId(sessionId)
						toolBlobMap.set(tc.id, blobId)
						await writeToolCallBlob(sessionId, blobId, tc.name, tc.input)
						emitEvent(sessionId, {
							type: 'tool-call',
							toolId: tc.id,
							name: tc.name,
							input: tc.input,
							blobId,
							phase: 'running',
						})
						break
					}

					case 'server_tool': {
						if (event.serverBlocks) {
							serverBlocks.push(...event.serverBlocks)
							for (const sb of event.serverBlocks) {
								if (sb.type === 'server_tool_use' && sb.name === 'web_search' && typeof sb.id === 'string') {
									const input = webSearchInput(sb)
									const blobId = serverToolBlobMap.get(sb.id) ?? blob.makeBlobId(sessionId)
									serverToolBlobMap.set(sb.id, blobId)
									await writeToolCallBlob(sessionId, blobId, 'web_search', input)
									serverToolHistory.push({ type: 'tool_call', toolId: sb.id, name: 'web_search', input, blobId, visibility: 'ui', ts: new Date().toISOString() })
									emitEvent(sessionId, { type: 'tool-call', toolId: sb.id, name: 'web_search', input, blobId, phase: 'running' })
								}
								if (sb.type === 'web_search_tool_result' && typeof sb.tool_use_id === 'string') {
									const output = formatWebSearchResults(sb)
									const blobId = serverToolBlobMap.get(sb.tool_use_id) ?? blob.makeBlobId(sessionId)
									serverToolBlobMap.set(sb.tool_use_id, blobId)
									await writeToolResultBlob(sessionId, blobId, output)
									serverToolHistory.push({ type: 'tool_result', toolId: sb.tool_use_id, blobId, visibility: 'ui', ts: new Date().toISOString() })
									emitEvent(sessionId, { type: 'tool-result', toolId: sb.tool_use_id, name: 'web_search', output: output.slice(0, 500), blobId, phase: 'done' })
								}
							}
						}
						break
					}


					case 'error': {
						const status = event.status
						const blobId = blob.makeBlobId(sessionId)
						await writeErrorBlob(sessionId, blobId, event)

						const header = status ? `${status}:` : 'Error:'
						const endpoint = event.endpoint ? ` (${event.endpoint})` : ''
						const errorText = `${header}${endpoint}\n${formatErrorDetails(event, `${sessionId}/${blobId}`)}`
						emitEvent(sessionId, {
							type: 'response',
							text: errorText,
							isError: true,
							blobId,
						})
						const contextWarning = isContextLengthError(event) ? formatContextLengthWarning(messages, model, overheadBytes) : null
						if (contextWarning) emitInfo(sessionId, contextWarning, 'error')
						let canRetry = false
						if (isRetryableStatus(status)) {
							if (!retryStartedAt) retryStartedAt = Date.now()
							const elapsed = Date.now() - retryStartedAt
							if (elapsed < config.retryMaxTotalMs) {
								// Provider-set retryAfterMs wins (e.g. token rotation sets 1s).
								// Otherwise try resets_in_seconds from body, then exponential backoff.
								const bodyDelay = parseResetsInSeconds(event.body)
								const delay = event.retryAfterMs ?? bodyDelay ?? computeRetryDelay(undefined, retryAttempt)
								retryAttempt++
								const delaySec = Math.ceil(delay / 1000)
								emitInfo(sessionId, `Rate limited — retrying in ${delaySec}s`)
								await ctx.onStatus?.(true)
								await sleepWithAbort(delay, loopSignal)
								if (loopSignal.aborted) {
									aborted = true
									break
								}
								shouldRetry = true
								canRetry = true
							}
						}
						if (!canRetry) {
							hadTerminalError = true
							terminalErrorStatus = status
							terminalErrorEntry = errorHistoryEntry(errorText, blobId)
						}
						break
					}

					case 'pause':
						providerPaused = true
						iterationDone = true
						break

					case 'config':
						if (providerName === 'hal' && event.key && event.value != null) ctx.onConfig?.(event.key, event.value)
						break

						case 'done': {
							// Only reset retry state on actual success, not when we're about to retry
							if (!shouldRetry) {
								retryAttempt = 0
								retryStartedAt = 0
							}

							// Accumulate usage. Keep cache-read and cache-creation separate from
							// uncached input so the UI and cost math can weight them correctly.
							if (event.usage) {
								accounting.add(meter, event.usage)
								calibrateInputTokens(model, messages, overheadBytes, event.usage)
							}
							iterationDone = true
							lastDoneMeta = { status: event.doneStatus ?? 'completed' }
							break
						}
					}
				}
			} catch (err: any) {
				// Provider throws on abort (AbortError)
				if (loopSignal.aborted) {
					log.info('Agent loop aborted', { sessionId, error: err?.message, stack: err?.stack?.split('\n').slice(0, 5).join(' | ') })
					aborted = true
				} else {
					const message = err?.message ? String(err.message) : String(err)
					log.error('Agent loop error', { sessionId, message })
					emitInfo(sessionId, message, 'error')
					emitEvent(sessionId, { type: 'stream-end', phase: 'failed', message })
					if (!thinkingText && !assistantText && toolCalls.length === 0) {
						sessions.appendHistory(sessionId, [errorHistoryEntry(message)])
						sessions.clearLive(sessionId)
					}
					appendTurnEnd(sessionId, { status: 'failed' })
					return 'failed'
				}
			}
			// If aborted, emit partial output and exit.
			if (aborted) {
				await finishAborted()
				return 'aborted'
			}

			// If we need to retry, go back to the top of the loop
			if (shouldRetry) continue
			if (!thinkingText.trim()) thinkingText = ''
			if (!assistantText.trim()) assistantText = ''

			if (!iterationDone && !hadTerminalError) {
				const ts = new Date().toISOString()
				const historyEntries: any[] = []
				if (thinkingText) {
					const blobId = thinkingBlobId || blob.makeBlobId(sessionId)
					await writeThinkingBlob(sessionId, blobId, thinkingText, thinkingSignature || undefined)
					historyEntries.push({ type: 'thinking', model, thinkingEffort, blobId, ts })
				}
				for (const entry of serverToolHistory) historyEntries.push(entry)
				if (assistantText) historyEntries.push({ type: 'assistant', text: assistantText, model, ts })
				for (const tc of toolCalls) {
					const blobId = toolBlobMap.get(tc.id) ?? blob.makeBlobId(sessionId)
					toolBlobMap.set(tc.id, blobId)
					await writeToolCallBlob(sessionId, blobId, tc.name, tc.input)
					historyEntries.push({ type: 'tool_call', toolId: tc.id, name: tc.name, input: tc.input, blobId, ts })
				}
				const message = 'Provider stream ended before terminal event'
				historyEntries.push(errorHistoryEntry(message, undefined, ts))
				await sessions.appendHistory(sessionId, historyEntries)
				emitEvent(sessionId, { type: 'response', text: message, isError: true })
				emitEvent(sessionId, { type: 'stream-end', phase: 'failed', message })
				sessions.clearLive(sessionId)
				appendTurnEnd(sessionId, { status: 'failed' })
				return 'failed'
			}

			// No tool calls — save the final streamed blocks and finish.
			if (toolCalls.length === 0) {
				// Save the streamed blocks exactly as flat history entries.
				// Thinking stays separate from assistant text; large payloads still live in blobs.
				const ts = new Date().toISOString()
				const historyEntries: any[] = []
				if (thinkingText) {
					const blobId = thinkingBlobId || blob.makeBlobId(sessionId)
					await writeThinkingBlob(sessionId, blobId, thinkingText, thinkingSignature || undefined)
					historyEntries.push({
						type: 'thinking',
						model,
						thinkingEffort,
						blobId,
						ts,
					})
				}
				for (const entry of serverToolHistory) historyEntries.push(entry)
				if (assistantText) historyEntries.push({ type: 'assistant', text: assistantText, model, ts })
				if (providerPaused && model === 'hal/intro') {
					historyEntries.push({
						type: 'question',
						id: sessions.newHistoryIds(sessionId, 1)[0]!,
						text: 'Continue?',
						input: { kind: 'choice', choices: [{ id: 'continue', label: 'Continue' }] },
						source: { type: 'intro' },
						ts,
					})
				}
				if (terminalErrorEntry) historyEntries.push(terminalErrorEntry)
				let emptyResponseMessage = ''
				if (!thinkingText && !assistantText && serverToolHistory.length === 0 && !terminalErrorEntry) {
					// An empty provider reply is a failed turn, not a completed one: that way the
					// prompt shows the retry affordance and a bare Enter re-runs the turn.
					emptyResponseMessage = 'Provider returned an empty response. Please retry.'
					hadTerminalError = true
					historyEntries.push(errorHistoryEntry(emptyResponseMessage, undefined, ts))
				}
				if (historyEntries.length > 0) {
					await sessions.appendHistory(sessionId, historyEntries)
				}
				if (providerPaused && model === 'hal/intro') ipc.appendEvent({ type: 'history-updated', sessionId })
				if (emptyResponseMessage) emitEvent(sessionId, { type: 'response', text: emptyResponseMessage, isError: true })

				if (historyEntries.length > 0) {
					sessions.clearLive(sessionId)
				}
				const est = context.estimateContext(messages, model, overheadBytes)
				emitEvent(sessionId, {
					type: 'stream-end',
					phase: hadTerminalError ? 'failed' : 'done',
					usage: hasUsage(totalUsage) ? totalUsage : undefined,
					contextUsed: est.used,
					contextMax: est.max,
				})
				// Persist context so it survives restarts
				void sessions.updateMeta(sessionId, { context: { used: est.used, max: est.max } })
				if (providerPaused) return 'paused'
				if (hadTerminalError) {
					const failure = terminalErrorEntry ? { provider: providerName, httpStatus: terminalErrorStatus } : {}
					appendTurnEnd(sessionId, { status: 'failed', ...failure })
				}
				else appendTurnEnd(sessionId, lastDoneMeta ?? { status: 'completed' })
				return hadTerminalError ? 'failed' : 'completed'
			}

			// ── Tool execution ──
			// Build assistant message with text + tool_use blocks
			const assistantContent: any[] = []
			if (thinkingText && thinkingSignature) {
				assistantContent.push({ type: 'thinking', thinking: thinkingText, signature: thinkingSignature })
			}
			if (assistantText) {
				assistantContent.push({ type: 'text', text: assistantText })
			}
			// Include server-side tool blocks (web_search) — these are opaque blocks
			// that must appear in the assistant content alongside tool_use blocks.
			for (const sb of serverBlocks) assistantContent.push(sb)
			for (const tc of toolCalls) {
				assistantContent.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input })
			}
			messages.push({ role: 'assistant', content: assistantContent })

			// Save assistant response and each tool call as separate history entries.
			const ts = new Date().toISOString()
			const historyEntries: any[] = []
			if (thinkingText) {
				const blobId = thinkingBlobId || blob.makeBlobId(sessionId)
				await writeThinkingBlob(sessionId, blobId, thinkingText, thinkingSignature || undefined)
				historyEntries.push({
					type: 'thinking',
					model,
					thinkingEffort,
					blobId,
					ts,
				})
			}
			for (const entry of serverToolHistory) historyEntries.push(entry)
			if (assistantText) historyEntries.push({ type: 'assistant', text: assistantText, model, ts })
			for (const tc of toolCalls) {
				const blobId = toolBlobMap.get(tc.id) ?? blob.makeBlobId(sessionId)
				toolBlobMap.set(tc.id, blobId)
				await writeToolCallBlob(sessionId, blobId, tc.name, tc.input)
				historyEntries.push({ type: 'tool_call', toolId: tc.id, name: tc.name, input: tc.input, blobId, ts })
			}
			const pauseBeforeTools = hasPauseBeforeTools(sessionId)
			const riskyCalls = riskyToolCalls(toolCalls)
			const parked = pauseBeforeTools || riskyCalls.length > 0
			if (parked) {
				const ids = sessions.newHistoryIds(sessionId, riskyCalls.length + 1)
				const pendingId = ids[0]!
				historyEntries.push({
					type: 'pending_tools',
					id: pendingId,
					toolIds: toolCalls.map((call) => call.id),
					cwd: ctx.cwd,
					model,
					usage: usageOrUndefined(totalUsage),
					reason: riskyCalls.length > 0 ? 'questions' : 'soft-pause',
					ts,
				})
				for (let i = 0; i < riskyCalls.length; i++) {
					const item = riskyCalls[i]!
					historyEntries.push({
						type: 'question',
						id: ids[i + 1]!,
						text: toolQuestionText(item.call, item.findings),
						input: { kind: 'choice', choices: [{ id: 'no', label: 'No' }, { id: 'yes', label: 'Yes' }] },
						source: { type: 'tool', pendingId, toolId: item.call.id },
						ts,
					})
				}
			}
			await sessions.appendHistory(sessionId, historyEntries)
			sessions.clearLive(sessionId)

			if (parked) {
				clearPauseBeforeTools(sessionId)
				if (riskyCalls.length > 0) ipc.appendEvent({ type: 'history-updated', sessionId })
				else emitInfo(sessionId, '[paused before local tools]')
				const est = context.estimateContext(messages, model, overheadBytes)
				emitEvent(sessionId, {
					type: 'stream-end',
					phase: 'done',
					usage: usageOrUndefined(totalUsage),
					contextUsed: est.used,
					contextMax: est.max,
				})
				void sessions.updateMeta(sessionId, { context: { used: est.used, max: est.max } })
				return 'paused'
			}

			// Execute tools (with concurrency limit)
			await ctx.onStatus?.(true)
			const results = await executeToolBatch(sessionId, toolCalls, ctx.cwd, loopSignal, toolBlobMap)

			// Tool results from one assistant turn must stay together; compat providers
			// append image blocks only after every paired text result.
			messages.push({
				role: 'user',
				content: results.map(({ call, result }) => ({ type: 'tool_result' as const, tool_use_id: call.id, content: result })),
			})
			const subagentNotice = runningSubagentNotice(sessionId)
			if (subagentNotice) messages.push({ role: 'user', content: subagentNotice })

			await ctx.onStatus?.(true)
			// Only park the turn if a subagent is actually running. An empty wait has
			// nothing that could ever deliver a message to wake it, so parking would
			// strand the session; keep generating and let the model recover instead.
			if (toolCalls.some((call) => call.name === 'wait') && agentLoop.runningSubagents(sessionId).length > 0) {
				const est = context.estimateContext(messages, model, overheadBytes)
				emitEvent(sessionId, {
					type: 'stream-end',
					phase: 'done',
					usage: usageOrUndefined(totalUsage),
					contextUsed: est.used,
					contextMax: est.max,
				})
				void sessions.updateMeta(sessionId, { context: { used: est.used, max: est.max } })
				appendTurnEnd(sessionId, { status: 'completed' })
				return 'waiting'
			}

			// Continue to next iteration (re-invoke the model with tool results)
		}

		if (loopSignal.aborted) {
			await finishAborted()
			return 'aborted'
		}

		// If we exhausted maxIterations, pause in a continuable state. `stream-end`
		// closes the live UI stream, but we deliberately do not append `turn_end`:
		// the agent turn has not semantically finished, and Enter should continue it.
		const stopText = `Hit max iterations (${config.maxIterations}). Stopping.`
		sessions.appendHistory(sessionId, [errorHistoryEntry(stopText)])
		sessions.clearLive(sessionId)
		emitInfo(sessionId, stopText, 'error')
		const est = context.estimateContext(messages, model, overheadBytes)
		emitEvent(sessionId, {
			type: 'stream-end',
			phase: 'done',
			usage: totalUsage,
			contextUsed: est.used,
			contextMax: est.max,
		})
		void sessions.updateMeta(sessionId, { context: { used: est.used, max: est.max } })

		return 'paused'
	} finally {
		try {
			accounting.save(sessionId, meter)
		} catch (error) {
			log.error('Failed to persist usage receipt', { sessionId, error })
		}
		// A new prompt can deliberately displace this turn before this
		// async function has fully unwound. Only remove the working controller if
		// it is still ours; otherwise the older request would make the newer
		// request look idle and later prompts would start concurrently.
		if (state.workingRequests.get(sessionId) === ac) state.workingRequests.delete(sessionId)
		state.abortTexts.delete(ac)
		clearPauseBeforeTools(sessionId)
		try {
			await ctx.onStatus?.(false)
		} finally {
			const settled = state.settledRequests.get(ac)
			state.settledRequests.delete(ac)
			settled?.resolve()
		}
	}
}

/** Execute tool calls with a concurrency cap. */
async function executeToolsConcurrently(
	toolCalls: ToolCall[],
	signal: AbortSignal,
	cwd?: string,
	sessionId?: string,
	onOutput?: (call: ToolCall, output: string) => void,
	onDone?: (call: ToolCall, result: ToolOutput) => Promise<void>,
	policy: { approvedRisk?: ReadonlySet<string>; rejected?: ReadonlySet<string> } = {},
): Promise<{ call: ToolCall; result: ToolOutput }[]> {
	const results: { call: ToolCall; result: ToolOutput }[] = []
	const context = { sessionId: sessionId ?? 'unknown', cwd: cwd ?? process.cwd(), signal }

	for (let i = 0; i < toolCalls.length; i += config.maxToolConcurrency) {
		if (signal.aborted) {
			for (const call of toolCalls.slice(i)) {
				const result = '[interrupted]'
				await onDone?.(call, result)
				results.push({ call, result })
			}
			break
		}
		const batch = toolCalls.slice(i, i + config.maxToolConcurrency)
		const batchResults = await Promise.all(
			batch.map(async (call) => {
				async function finish(result: ToolOutput): Promise<{ call: ToolCall; result: ToolOutput }> {
					await onDone?.(call, result)
					return { call, result }
				}
				if (signal.aborted) return finish('[interrupted]')
				if (policy.rejected?.has(call.id)) return finish('error: user rejected risky tool call')
				try {
					const result = await toolRegistry.dispatch(call.name, call.input, {
						...context,
						approvedRisk: policy.approvedRisk?.has(call.id) || undefined,
						onOutput: (output) => onOutput?.(call, output),
					})
					return finish(result)
				} catch (err: any) {
					return finish(`error: ${err?.message ?? String(err)}`)
				}
			}),
		)
		results.push(...batchResults)
	}

	return results
}

async function executeToolBatch(
	sessionId: string,
	toolCalls: ToolCall[],
	cwd: string,
	signal: AbortSignal,
	toolBlobMap?: Map<string, string>,
	policy: { approvedRisk?: ReadonlySet<string>; rejected?: ReadonlySet<string> } = {},
): Promise<{ call: ToolCall; result: ToolOutput; blobId: string }[]> {
	const blobs = toolBlobMap ?? new Map<string, string>()
	for (const call of toolCalls) {
		if (!blobs.has(call.id)) blobs.set(call.id, blob.makeBlobId(sessionId))
	}
	async function saveCompletedTool(call: ToolCall, result: ToolOutput): Promise<void> {
		const blobId = blobs.get(call.id)!
		const existing = blob.readBlob(sessionId, blobId) ?? { call: { name: call.name, input: call.input } }
		existing.result = { content: result, status: 'done' }
		await blob.writeBlob(sessionId, blobId, existing)
		emitEvent(sessionId, {
			type: 'tool-result',
			toolId: call.id,
			name: call.name,
			output: toolRegistry.outputText(result),
			blobId,
			phase: 'done',
		})
	}

	const results = await executeToolsConcurrently(toolCalls, signal, cwd, sessionId, (call, output) => {
		emitEvent(sessionId, {
			type: 'tool-result',
			toolId: call.id,
			name: call.name,
			output: toolOutputPreview(output),
			blobId: blobs.get(call.id),
			phase: 'running',
		})
	}, saveCompletedTool, policy)
	await sessions.appendHistory(sessionId, results.map(({ call }) => ({ type: 'tool_result', toolId: call.id, blobId: blobs.get(call.id)!, ts: new Date().toISOString() })))
	const saved: { call: ToolCall; result: ToolOutput; blobId: string }[] = []
	for (const { call, result } of results) {
		saved.push({ call, result, blobId: blobs.get(call.id)! })
	}
	return saved
}

function requestPauseBeforeTools(sessionId: string): boolean {
	if (!state.workingRequests.has(sessionId)) return false
	state.pauseBeforeTools.add(sessionId)
	return true
}

function clearPauseBeforeTools(sessionId: string): void {
	state.pauseBeforeTools.delete(sessionId)
}

function hasPauseBeforeTools(sessionId: string): boolean {
	return state.pauseBeforeTools.has(sessionId)
}

/** Abort an working turn for a session. */
function abort(sessionId: string, text = DEFAULT_ABORT_TEXT): boolean {
	const ac = state.workingRequests.get(sessionId)
	if (ac) {
		log.info('Agent loop explicit abort', { sessionId, text })
		// An abort has one terminal history entry. The first requester owns its text
		// so a later continuation cannot rewrite a visible pause into a silent one.
		if (!state.abortTexts.has(ac)) state.abortTexts.set(ac, text)
		ac.abort()
		return true
	}
	return false
}

/** Abort the current turn and wait until that specific invocation has fully unwound. */
function abortAndWait(sessionId: string, text = DEFAULT_ABORT_TEXT): Promise<void> | false {
	const ac = state.workingRequests.get(sessionId)
	if (!ac) return false
	abort(sessionId, text)
	return state.settledRequests.get(ac)?.promise ?? false
}

/** Check if a session has an working turn. */
function isWorking(sessionId: string): boolean {
	return state.workingRequests.has(sessionId)
}

export const agentLoop = {
	config,
	state,
	runAgentLoop,
	abort,
	abortAndWait,
	isWorking,
	requestPauseBeforeTools,
	clearPauseBeforeTools,
	hasPauseBeforeTools,
	executeToolBatch,
	sanitizeToolCallInput,
	runningSubagentNotice,
	runningSubagents,
	toolQuestionText,
	riskyToolCalls,
}
