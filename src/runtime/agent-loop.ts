// Agent loop — the core generation cycle.
//
// Drives a provider to generate responses, handles streaming, tool execution,
// and the re-invoke loop (generate → tool_use → tool_result → generate).
//
// Provider interface is defined in protocol.ts. Provider implementations
// are loaded lazily via providers/provider.ts.

import { resolve } from 'path'
import { homedir } from 'os'
import { ipc } from '../ipc.ts'
import { protocol } from '../protocol.ts'
import type { Provider, ProviderStreamEvent, Message, ToolDef } from '../protocol.ts'
import { models } from '../models.ts'
import { context } from './context.ts'
import { provider as providerLoader } from '../providers/provider.ts'
import { toolRegistry } from '../tools/tool.ts'
import { sessions } from '../server/sessions.ts'
import { blob } from '../session/blob.ts'
import { log } from '../utils/log.ts'
import { ason } from '../utils/ason.ts'
// Import all tool modules so they self-register on load
import '../tools/bash.ts'
import '../tools/read.ts'
import '../tools/read_blob.ts'
import '../tools/grep.ts'
import '../tools/glob.ts'
import '../tools/write.ts'
import '../tools/eval.ts'
import '../tools/send.ts'
import '../tools/google.ts'
import '../tools/read_url.ts'
import '../tools/analyze_history.ts'
// Anthropic also has its own server-side web_search tool
// (type: 'web_search_20250305'). That's separate from our local google tool.

// ── Configuration ──

const config = {
	/** Maximum tool→generate cycles before we force-stop. */
	maxIterations: 50,
	/** Max concurrent tool executions per cycle. */
	maxToolConcurrency: 5,
	/** Retry config for transient API errors. */
	retryBaseDelayMs: 5_000,
	retryMaxTotalMs: 2 * 60 * 60 * 1000, // 2 hours
	retryableStatuses: new Set([429, 500, 503, 529]),
}

// ── State ──

const state = {
	/** Active generation abort controllers, keyed by session ID. */
	activeRequests: new Map<string, AbortController>(),
	/** Info text to emit when an aborted generation finishes unwinding. */
	abortTexts: new Map<string, string>(),
}

const DEFAULT_ABORT_TEXT = '[paused]'

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
	/** Callback for busy/activity status updates. */
	onStatus?: (busy: boolean, activity?: string) => void | Promise<void>
}

interface ToolCall {
	id: string
	name: string
	input: any
}

// ── Provider loading ──
// Providers are loaded lazily via providers/provider.ts.
// getProvider() is async because it may need to dynamically import modules.

async function getProvider(name: string): Promise<Provider> {
	return providerLoader.getProvider(name)
}

// ── IPC helpers ──

function emitEvent(sessionId: string, event: Record<string, any>): void {
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
	return status != null && config.retryableStatuses.has(status)
}

/** Extract resets_in_seconds from error response body (Anthropic rate limit format). */
function parseResetsInSeconds(body: string | undefined): number | undefined {
	if (!body) return undefined
	try {
		const json = JSON.parse(body)
		// Anthropic nests it under error.resets_in_seconds
		const secs = json?.error?.resets_in_seconds ?? json?.resets_in_seconds
		if (typeof secs === 'number' && secs > 0) return secs * 1000
	} catch {}
	return undefined
}

/** Pretty-format an error body for display. Parse JSON and print it as ASON. */
function formatErrorBody(body: string): string {
	try {
		return ason.stringify(JSON.parse(body), 'long')
	} catch {
		return body
	}
}

/** Build the user-visible error details below the status/endpoint header. */
function formatErrorDetails(event: ProviderStreamEvent): string {
	const prettyBody = event.body ? formatErrorBody(event.body) : ''

	// Provider messages like "Anthropic API 429" add no value once the header
	// already shows the status code. In that case, show the payload instead.
	if (event.status === 429 && prettyBody) {
		if (!event.message || event.message === `Anthropic API ${event.status}` || event.message === `OpenAI API ${event.status}`) {
			return prettyBody
		}
		return `${event.message}\n${prettyBody}`
	}

	if (prettyBody) return prettyBody
	return event.message ?? 'Unknown error'
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

// ── Tool call normalization ──
// Strip redundant "cd $CWD && " prefix that models prepend to bash commands.
// The tool already runs in the correct cwd, so this is pure noise.

const HOME = homedir()

function resolveTilde(p: string): string {
	return p.startsWith('~/') ? HOME + p.slice(1) : p
}

function stripCdCwd(call: ToolCall, cwd: string): ToolCall {
	if (call.name !== 'bash') return call
	const cmd = String((call.input as any)?.command ?? '')
	const m = cmd.match(/^cd\s+(\S+)\s*&&\s*/)
	if (!m) return call
	const target = resolve(resolveTilde(m[1]!))
	if (target !== cwd) return call
	return { ...call, input: { ...call.input, command: cmd.slice(m[0].length) } }
}

// ── Tool execution ──
// Dispatches tool calls through the tool registry. Each tool module
// registers itself on import (see imports above).

async function executeTool(call: ToolCall, signal?: AbortSignal, cwd?: string, sessionId?: string): Promise<string> {
	const context: import('../tools/tool.ts').ToolContext = {
		sessionId: sessionId ?? 'unknown',
		cwd: cwd ?? process.cwd(),
		signal,
	}
	return toolRegistry.dispatch(call.name, call.input, context)
}

// ── The main loop ──

async function runAgentLoop(ctx: AgentContext): Promise<void> {
	const { sessionId, model, systemPrompt, messages, signal } = ctx

	// Parse "provider/model-id" — e.g. "anthropic/claude-opus-4-6"
	const slashIdx = model.indexOf('/')
	const providerName = slashIdx >= 0 ? model.slice(0, slashIdx) : 'stub'
	const modelId = slashIdx >= 0 ? model.slice(slashIdx + 1) : model
	const provider = await getProvider(providerName)

	// Abort any existing generation for this session. This prevents two
	// concurrent generations on the same session (race between client
	// sending 'prompt' and receiving the 'status: busy' event).
	const existing = state.activeRequests.get(sessionId)
	if (existing) {
		log.info('Aborting existing generation (displaced by new one)', { sessionId })
		existing.abort()
	}

	// Register abort controller so external code can abort us
	const ac = new AbortController()
	state.activeRequests.set(sessionId, ac)

	// If caller passed a signal, propagate its abort to our controller
	if (signal) {
		if (signal.aborted) {
			log.info('Agent loop skipped (signal already aborted)', { sessionId })
			ac.abort()
			return
		}
		signal.addEventListener('abort', () => {
			log.info('Agent loop abort via parent signal', { sessionId })
			ac.abort()
		}, { once: true })
	}

	const loopSignal = ac.signal

	// Get tool definitions from the registry for the provider API
	const tools: ToolDef[] = toolRegistry.toToolDefs()

	const overheadBytes = systemPrompt.length + JSON.stringify(tools).length
	await ctx.onStatus?.(true, 'generating...')

	try {
		const totalUsage = { input: 0, output: 0 }
		let retryAttempt = 0
		let retryStartedAt = 0

		async function finishAborted(): Promise<void> {
			const abortText = state.abortTexts.has(sessionId) ? (state.abortTexts.get(sessionId) ?? '') : DEFAULT_ABORT_TEXT
			if (abortText) emitInfo(sessionId, abortText)
			const est = context.estimateContext(messages, model, overheadBytes)
			emitEvent(sessionId, {
				type: 'stream-end',
				phase: 'done',
				usage: totalUsage.input > 0 ? totalUsage : undefined,
				contextUsed: est.used,
				contextMax: est.max,
			})
			// Persist context so it survives restarts.
			void sessions.updateMeta(sessionId, { context: { used: est.used, max: est.max } })
		}

		// Outer loop: each iteration is one generate call.
		// We loop when the model returns tool_use blocks.
		for (let iteration = 0; iteration < config.maxIterations; iteration++) {
			if (loopSignal.aborted) break

			// Call the provider's streaming generator
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
			const toolBlobMap = new Map<string, string>()
			const toolCalls: ToolCall[] = []
			// Server-side tool blocks (e.g. web_search) — opaque, go into assistant content verbatim
			const serverBlocks: any[] = []
			let aborted = false
			let shouldRetry = false

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
							})
							break

					case 'tool_call': {
						const tc = stripCdCwd({
							id: event.id!,
							name: event.name!,
							input: event.input,
						}, ctx.cwd)
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
						// Server-side tool blocks (web_search) — collect for assistant content
						if (event.serverBlocks) {
							serverBlocks.push(...event.serverBlocks)
							// Show web search activity to the user
							for (const sb of event.serverBlocks) {
								if (sb.type === 'server_tool_use' && sb.name === 'web_search') {
									const query = sb.input?.query ?? ''
									emitInfo(sessionId, `[web_search] "${query}"`)
								}
							}
						}
						break
					}

					case 'status':
						if (event.activity) await ctx.onStatus?.(true, event.activity)
						break

					case 'error': {
						const status = event.status

						const header = status ? `${status}:` : 'Error:'
						const endpoint = event.endpoint ? ` (${event.endpoint})` : ''
						emitEvent(sessionId, {
							type: 'response',
							text: `${header}${endpoint}\n${formatErrorDetails(event)}`,
							isError: true,
						})
						// Check if we should retry
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
								await ctx.onStatus?.(true, `rate limited — retrying in ${delaySec}s...`)
								await sleepWithAbort(delay, loopSignal)
								if (loopSignal.aborted) {
									aborted = true
									break
								}
								shouldRetry = true
							}
						}
						break
					}

						case 'done': {
							// Only reset retry state on actual success, not when we're about to retry
							if (!shouldRetry) {
								retryAttempt = 0
								retryStartedAt = 0
							}

							// Accumulate usage
							if (event.usage) {
								totalUsage.input += event.usage.input
								totalUsage.output += event.usage.output
							}
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
					return
				}
			}

			// If aborted, emit partial output and exit.
			if (aborted) {
				await finishAborted()
				return
			}

			// If we need to retry, go back to the top of the loop
			if (shouldRetry) continue

			// No tool calls — we're done. Emit a response event so the client
			// can display the assistant's text (client listens for 'response' events).
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
						blobId,
						ts,
					})
				}
				if (assistantText) {
					const assistantEntry: any = { type: 'assistant', text: assistantText, ts }
					if (totalUsage.input > 0) assistantEntry.usage = totalUsage
					historyEntries.push(assistantEntry)
				}
				if (historyEntries.length > 0) {
					await sessions.appendHistory(sessionId, historyEntries)
					sessions.clearLive(sessionId)
				}

				if (assistantText) {
					emitEvent(sessionId, { type: 'response', text: assistantText })
				}
				const est = context.estimateContext(messages, model, overheadBytes)
				emitEvent(sessionId, {
					type: 'stream-end',
					phase: 'done',
					usage: totalUsage.input > 0 ? totalUsage : undefined,
					contextUsed: est.used,
					contextMax: est.max,
				})
				// Persist context so it survives restarts
				void sessions.updateMeta(sessionId, { context: { used: est.used, max: est.max } })
				return
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
					blobId,
					ts,
				})
			}
			if (assistantText) historyEntries.push({ type: 'assistant', text: assistantText, ts })
			for (const tc of toolCalls) {
				const blobId = toolBlobMap.get(tc.id) ?? blob.makeBlobId(sessionId)
				toolBlobMap.set(tc.id, blobId)
				await writeToolCallBlob(sessionId, blobId, tc.name, tc.input)
				historyEntries.push({ type: 'tool_call', toolId: tc.id, name: tc.name, input: tc.input, blobId, ts })
			}
			await sessions.appendHistory(sessionId, historyEntries)
			sessions.clearLive(sessionId)

			// Emit response event for intermediate text so the client can
			// create a proper block and clear streaming buffers. Without
			// this, text from successive iterations concatenates in the
			// streaming buffer (e.g. "controls.Now" with no separator).
			if (assistantText) {
				emitEvent(sessionId, { type: 'response', text: assistantText })
			}

			// Execute tools (with concurrency limit)
			await ctx.onStatus?.(true, `running ${toolCalls.length} tool(s)...`)
			const results = await executeToolsConcurrently(toolCalls, loopSignal, ctx.cwd, sessionId)

			// Add tool results to messages and save to history
			for (const { call, result } of results) {
				messages.push({
					role: 'user',
					content: [{ type: 'tool_result', tool_use_id: call.id, content: result }],
				})

				// Save tool result to blob and history
				const blobId = toolBlobMap.get(call.id)!
				const existing = blob.readBlob(sessionId, blobId)
				if (existing) {
					existing.result = { content: result, status: 'done' }
					await blob.writeBlob(sessionId, blobId, existing)
				}
				await sessions.appendHistory(sessionId, [{
					type: 'tool_result',
					toolId: call.id,
					blobId,
					ts: new Date().toISOString(),
				}])

				emitEvent(sessionId, {
					type: 'tool-result',
					toolId: call.id,
					name: call.name,
					output: result.slice(0, 500), // truncate for IPC
					blobId,
					phase: 'done',
				})
			}

			// Report context usage estimate
			const est = context.estimateContext(messages, model, overheadBytes)
			await ctx.onStatus?.(true, 'generating...')

			// Continue to next iteration (re-invoke the model with tool results)
		}

		if (loopSignal.aborted) {
			await finishAborted()
			return
		}

		// If we exhausted maxIterations, inform the user
		emitInfo(sessionId, `Hit max iterations (${config.maxIterations}). Stopping.`, 'error')
		const est = context.estimateContext(messages, model, overheadBytes)
		emitEvent(sessionId, {
			type: 'stream-end',
			phase: 'done',
			usage: totalUsage,
			contextUsed: est.used,
			contextMax: est.max,
		})
		void sessions.updateMeta(sessionId, { context: { used: est.used, max: est.max } })
	} finally {
		state.activeRequests.delete(sessionId)
		state.abortTexts.delete(sessionId)
		await ctx.onStatus?.(false)
	}
}

/** Execute tool calls with a concurrency cap. */
async function executeToolsConcurrently(
	toolCalls: ToolCall[],
	signal: AbortSignal,
	cwd?: string,
	sessionId?: string,
): Promise<{ call: ToolCall; result: string }[]> {
	const results: { call: ToolCall; result: string }[] = []

	// Process in batches of maxToolConcurrency
	for (let i = 0; i < toolCalls.length; i += config.maxToolConcurrency) {
		if (signal.aborted) break
		const batch = toolCalls.slice(i, i + config.maxToolConcurrency)
		const batchResults = await Promise.all(
			batch.map(async (call) => {
				if (signal.aborted) return { call, result: '[interrupted]' }
				try {
					const result = await executeTool(call, signal, cwd, sessionId)
					return { call, result }
				} catch (err: any) {
					return { call, result: `error: ${err?.message ?? String(err)}` }
				}
			}),
		)
		results.push(...batchResults)
	}

	return results
}

/** Abort an active generation for a session. */
function abort(sessionId: string, text = DEFAULT_ABORT_TEXT): boolean {
	const ac = state.activeRequests.get(sessionId)
	if (ac) {
		log.info('Agent loop explicit abort', { sessionId, text })
		state.abortTexts.set(sessionId, text)
		ac.abort()
		return true
	}
	return false
}

/** Check if a session has an active generation. */
function isActive(sessionId: string): boolean {
	return state.activeRequests.has(sessionId)
}

export const agentLoop = {
	config,
	state,
	runAgentLoop,
	abort,
	isActive,
}
