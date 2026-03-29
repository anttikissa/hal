// Agent loop — the core generation cycle.
//
// Drives a provider to generate responses, handles streaming, tool execution,
// and the re-invoke loop (generate → tool_use → tool_result → generate).
//
// Provider interface is defined in protocol.ts. Provider implementations
// are loaded lazily via providers/provider.ts.

import { ipc } from '../ipc.ts'
import { protocol } from '../protocol.ts'
import type { Provider, ProviderStreamEvent, Message, ToolDef } from '../protocol.ts'
import { models } from '../models.ts'
import { context } from './context.ts'
import { provider as providerLoader } from '../providers/provider.ts'
import { toolRegistry } from '../tools/tool.ts'
import { sessions } from '../server/sessions.ts'
import { blob } from '../session/blob.ts'
// Import all tool modules so they self-register on load
import '../tools/bash.ts'
import '../tools/read.ts'
import '../tools/read_blob.ts'
import '../tools/grep.ts'
import '../tools/glob.ts'
import '../tools/write.ts'
import '../tools/eval.ts'
import '../tools/send.ts'

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
	ipc.appendEvent({
		id: protocol.eventId(),
		sessionId,
		createdAt: new Date().toISOString(),
		...event,
	})
}

function emitInfo(sessionId: string, text: string, level: 'info' | 'error' = 'info'): void {
	emitEvent(sessionId, { type: 'info', text, level })
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

/** Pretty-format an error body for display. Try to indent JSON, fall back to raw text. */
function formatErrorBody(body: string): string {
	try {
		const parsed = JSON.parse(body)
		return JSON.stringify(parsed, null, 2)
	} catch {
		return body
	}
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
	if (existing) existing.abort()

	// Register abort controller so external code can abort us
	const ac = new AbortController()
	state.activeRequests.set(sessionId, ac)

	// If caller passed a signal, propagate its abort to our controller
	if (signal) {
		if (signal.aborted) {
			ac.abort()
			return
		}
		signal.addEventListener('abort', () => ac.abort(), { once: true })
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
			const toolCalls: ToolCall[] = []
			let aborted = false
			let shouldRetry = false

			try {
				for await (const event of gen) {
					if (loopSignal.aborted) {
						aborted = true
						break
					}

					switch (event.type) {
						case 'thinking':
							thinkingText += event.text ?? ''
							emitEvent(sessionId, {
								type: 'stream-delta',
								text: event.text,
								channel: 'thinking',
							})
							break

						case 'thinking_signature':
							thinkingSignature = event.signature ?? ''
							break

						case 'text':
							assistantText += event.text ?? ''
							emitEvent(sessionId, {
								type: 'stream-delta',
								text: event.text,
								channel: 'assistant',
							})
							break

						case 'tool_call':
							toolCalls.push({
								id: event.id!,
								name: event.name!,
								input: event.input,
							})
							emitEvent(sessionId, {
								type: 'tool-call',
								toolId: event.id,
								name: event.name,
								input: event.input,
								phase: 'running',
							})
							break

						case 'error': {
							const status = event.status

							// Show the full error body so the user sees the actual API response
							const header = status ? `${status}:` : 'Error:'
							const endpoint = event.endpoint ? ` (${event.endpoint})` : ''
							const body = event.body ?? event.message ?? 'Unknown error'
							emitEvent(sessionId, {
								type: 'response',
								text: `${header}${endpoint}\n${formatErrorBody(body)}`,
								isError: true,
							})
							// Check if we should retry
							if (isRetryableStatus(status)) {
								if (!retryStartedAt) retryStartedAt = Date.now()
								const elapsed = Date.now() - retryStartedAt
								if (elapsed < config.retryMaxTotalMs) {
									// Prefer resets_in_seconds from body, then Retry-After header, then exponential backoff
									const bodyDelay = parseResetsInSeconds(event.body)
									const delay = bodyDelay ?? computeRetryDelay(event.retryAfterMs, retryAttempt)
									retryAttempt++
									const delaySec = Math.ceil(delay / 1000)
									emitInfo(sessionId, `Rate limited — retrying in ${delaySec}s`)
									await ctx.onStatus?.(true, `rate limited — retrying in ${delaySec}s...`)
									await Bun.sleep(delay)
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
					aborted = true
				} else {
					const message = err?.message ? String(err.message) : String(err)
					emitInfo(sessionId, message, 'error')
					emitEvent(sessionId, { type: 'stream-end', phase: 'failed', message })
					return
				}
			}

			// If aborted, emit partial output and exit
			if (aborted) {
				emitInfo(sessionId, '[paused]')
				const est = context.estimateContext(messages, model, overheadBytes)
				emitEvent(sessionId, {
					type: 'stream-end',
					phase: 'done',
					usage: totalUsage.input > 0 ? totalUsage : undefined,
					contextUsed: est.used,
					contextMax: est.max,
				})
				return
			}

			// If we need to retry, go back to the top of the loop
			if (shouldRetry) continue

			// No tool calls — we're done. Emit a response event so the client
			// can display the assistant's text (client listens for 'response' events).
			if (toolCalls.length === 0) {
				// Save assistant response to history
				if (assistantText || thinkingText) {
					const historyEntry: any = {
						role: 'assistant',
						ts: new Date().toISOString(),
					}
					if (assistantText) historyEntry.text = assistantText
					if (thinkingText && thinkingSignature) {
						const blobId = blob.makeBlobId(sessionId)
						await blob.writeBlob(sessionId, blobId, {
							thinking: thinkingText,
							signature: thinkingSignature,
						})
						historyEntry.thinkingBlobId = blobId
					}
					if (totalUsage.input > 0) historyEntry.usage = totalUsage
					await sessions.appendHistory(sessionId, [historyEntry])
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
			for (const tc of toolCalls) {
				assistantContent.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input })
			}
			messages.push({ role: 'assistant', content: assistantContent })

			// Save assistant message with tool calls to history
			const toolBlobMap = new Map<string, string>()
			const historyEntry: any = {
				role: 'assistant',
				ts: new Date().toISOString(),
			}
			if (assistantText) historyEntry.text = assistantText
			if (thinkingText && thinkingSignature) {
				const blobId = blob.makeBlobId(sessionId)
				await blob.writeBlob(sessionId, blobId, { thinking: thinkingText, signature: thinkingSignature })
				historyEntry.thinkingBlobId = blobId
			}
			// Save each tool call input to a blob
			historyEntry.tools = []
			for (const tc of toolCalls) {
				const blobId = blob.makeBlobId(sessionId)
				toolBlobMap.set(tc.id, blobId)
				await blob.writeBlob(sessionId, blobId, { call: { name: tc.name, input: tc.input } })
				historyEntry.tools.push({ id: tc.id, name: tc.name, blobId })
			}
			await sessions.appendHistory(sessionId, [historyEntry])

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
				await sessions.appendHistory(sessionId, [
					{
						role: 'tool_result',
						tool_use_id: call.id,
						blobId,
						ts: new Date().toISOString(),
					},
				])

				emitEvent(sessionId, {
					type: 'tool-result',
					toolId: call.id,
					name: call.name,
					output: result.slice(0, 500), // truncate for IPC
					phase: 'done',
				})
			}

			// Report context usage estimate
			const est = context.estimateContext(messages, model, overheadBytes)
			await ctx.onStatus?.(true, 'generating...')

			// Continue to next iteration (re-invoke the model with tool results)
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
	} finally {
		state.activeRequests.delete(sessionId)
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
function abort(sessionId: string): boolean {
	const ac = state.activeRequests.get(sessionId)
	if (ac) {
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
