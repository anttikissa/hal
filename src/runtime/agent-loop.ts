// Agent loop — runs a single generation for a session.
// Drives the provider, emits IPC events, persists to messages.asonl.
// Supports tool execution with re-invoke loop.

import { loadProvider, type ProviderEvent } from './provider.ts'
import { events } from '../ipc.ts'
import { appendMessages, writeAssistantEntry, writeToolResultEntry, updateBlockInput, readBlock } from '../session/messages.ts'
import { eventId } from '../protocol.ts'
import type { RuntimeEvent, EventLevel } from '../protocol.ts'
import { TOOLS, executeTool, argsPreview, truncate, type ToolCall } from './tools.ts'
import { runHooks } from './hooks.ts'
import { contextWindowForModel, isCalibrated, saveCalibration, estimateTokens, messageBytes } from './context.ts'

export interface AgentContext {
	sessionId: string
	model: string
	systemPrompt: string
	messages: any[]
	onStatus: (busy: boolean, activity?: string, context?: { used: number; max: number; estimated?: boolean }) => void
	askUser: (question: string) => Promise<string>
	signal?: AbortSignal
}

function emit(sessionId: string, event: Partial<RuntimeEvent> & { type: RuntimeEvent['type'] }): Promise<void> {
	return events.append({
		id: eventId(), sessionId, createdAt: new Date().toISOString(), ...event,
	} as RuntimeEvent)
}

/** Emit IPC line event AND persist as info message. */
async function emitInfo(sessionId: string, text: string, level: EventLevel, detail?: string): Promise<void> {
	await appendMessages(sessionId, [{ type: 'info', text, level, detail, ts: new Date().toISOString() }])
	await emit(sessionId, { type: 'line', text, level, detail })
}

export async function runAgentLoop(ctx: AgentContext): Promise<void> {
	const { sessionId, model, systemPrompt, messages, signal } = ctx
	const [providerName, modelId] = model.includes('/') ? model.split('/', 2) : ['mock', model]
	const ctxMax = contextWindowForModel(modelId)
	let calibrated = isCalibrated(modelId)

	// Emit estimated context before first API call
	let totalBytes = systemPrompt.length
	for (const m of messages) totalBytes += messageBytes(m)
	const estimated = estimateTokens(totalBytes, modelId)
	ctx.onStatus(true, 'generating...', { used: estimated, max: ctxMax, estimated: true })

	try {
		const provider = await loadProvider(providerName)

		while (!signal?.aborted) {

			const gen = provider.generate({ messages, model: modelId, systemPrompt, tools: TOOLS, signal, sessionId })

			let thinkingText = ''
			let assistantText = ''
			const toolCalls: ToolCall[] = []
			let aborted = false

			for await (const event of gen) {
				if (signal?.aborted) { aborted = true; break }
				switch (event.type) {
					case 'thinking':
						thinkingText += event.text
						await emit(sessionId, { type: 'chunk', text: event.text, channel: 'thinking' })
						break
					case 'text':
						assistantText += event.text
						await emit(sessionId, { type: 'chunk', text: event.text, channel: 'assistant' })
						break
					case 'tool_call':
						toolCalls.push({ id: event.id, name: event.name, input: event.input })
						break
					case 'error': {
						const detail = event.body
							? (event.status ? `${event.status}: ${event.body}` : event.body)
							: event.message
						await emitInfo(sessionId, event.message, 'error', detail)
						break
					}
					case 'done': {
						// Calibrate bytes→tokens ratio on first API response
						if (!calibrated && event.usage && event.usage.input > 0) {
							calibrated = true
							saveCalibration(modelId, totalBytes, event.usage.input)
						}
						if (toolCalls.length === 0) {
							// No tools — persist and finish
							await appendMessages(sessionId, [
								{ role: 'assistant', text: assistantText || undefined, thinkingText: thinkingText || undefined, ts: new Date().toISOString() },
							])
							if (event.usage) ctx.onStatus(true, undefined, { used: event.usage.input, max: ctxMax })
							await emit(sessionId, {
								type: 'command', commandId: '', phase: 'done',
								message: event.usage ? `${event.usage.input}→${event.usage.output} tokens` : undefined,
							})
							return
						}

						// Write assistant entry BEFORE executing tools
						const { entry: assistantEntry, toolRefMap } = await writeAssistantEntry(sessionId, {
							text: assistantText || undefined,
							thinkingText: thinkingText || undefined,
							toolCalls,
						})
						await appendMessages(sessionId, [assistantEntry])
						if (event.usage) ctx.onStatus(true, undefined, { used: event.usage.input, max: ctxMax })

						// Execute tools, writing each result individually
						for (let call of toolCalls) {
							if (signal?.aborted) { aborted = true; break }
							const original = call
							call = runHooks(call)
							if (call.input !== original.input) {
								const ref = toolRefMap.get(call.id)
								if (ref) await updateBlockInput(sessionId, ref, call.input, original.input)
							}
							const args = argsPreview(call)

							let result: string
							if (call.name === 'ask') {
								const question = (call.input as any)?.question ?? ''
								result = await ctx.askUser(question) || '[no answer]'
							} else {
								const ref = toolRefMap.get(call.id)
								await emit(sessionId, {
									type: 'tool', toolId: call.id, name: call.name,
									args, phase: 'running', ref,
								})
								const onChunk = (text: string) => emit(sessionId, {
									type: 'tool', toolId: call.id, name: call.name,
									args, phase: 'streaming', output: text,
								})
								result = await executeTool(call, onChunk)
								await emit(sessionId, {
									type: 'tool', toolId: call.id, name: call.name,
									args, phase: 'done', output: result, ref,
								})
							}

							// Persist tool result immediately
							const toolResultEntry = await writeToolResultEntry(sessionId, call.id, result, toolRefMap)
							await appendMessages(sessionId, [toolResultEntry])
						}

						if (aborted) break

						// Add to messages for next round
						messages.push({
							role: 'assistant',
							content: [
								...(assistantText ? [{ type: 'text', text: assistantText }] : []),
								...toolCalls.map(t => ({
									type: 'tool_use', id: t.id, name: t.name, input: t.input,
								})),
							],
						})
						for (const call of toolCalls) {
							const ref = toolRefMap.get(call.id)!
							const block = await readBlock(sessionId, ref)
							messages.push({
								role: 'user',
								content: [{ type: 'tool_result', tool_use_id: call.id, content: truncate(block?.result?.content ?? '') }],
							})
						}

						break
					}
				}
			}

			if (aborted) {
				// Persist partial output before exiting
				if (assistantText || thinkingText) {
					await appendMessages(sessionId, [
						{ role: 'assistant', text: assistantText || undefined, thinkingText: thinkingText || undefined, ts: new Date().toISOString() },
					])
				}
				await emitInfo(sessionId, '[paused]', 'meta')
				await emit(sessionId, { type: 'command', commandId: '', phase: 'done' })
				return
			}

		}
	} catch (err: any) {
		if (signal?.aborted) {
			await emitInfo(sessionId, '[paused]', 'meta')
			await emit(sessionId, { type: 'command', commandId: '', phase: 'done' })
			return
		}
		const detail = err.status ? `${err.status}: ${err.message}` : err.stack ?? err.message
		await emitInfo(sessionId, err.message, 'error', detail)
		await emit(sessionId, { type: 'command', commandId: '', phase: 'failed', message: err.message })
	} finally {
		ctx.onStatus(false)
	}
}