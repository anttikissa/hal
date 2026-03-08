// Agent loop — runs a single generation for a session.
// Drives the provider, emits IPC events, persists to messages.asonl.
// Supports tool execution with re-invoke loop.

import { loadProvider, type ProviderEvent } from './provider.ts'
import { events } from '../ipc.ts'
import { appendMessages, writeAssistantEntry, writeToolResultEntry, readBlock } from '../session/messages.ts'
import { eventId } from '../protocol.ts'
import type { RuntimeEvent } from '../protocol.ts'
import { TOOLS, executeTool, argsPreview, type ToolCall } from './tools.ts'

export interface AgentContext {
	sessionId: string
	model: string
	systemPrompt: string
	messages: any[]
	onStatus: (busy: boolean, activity?: string) => void
	signal?: AbortSignal
}

function emit(sessionId: string, event: Partial<RuntimeEvent> & { type: RuntimeEvent['type'] }): Promise<void> {
	return events.append({
		id: eventId(), sessionId, createdAt: new Date().toISOString(), ...event,
	} as RuntimeEvent)
}

const MAX_TOOL_ROUNDS = 10
export async function runAgentLoop(ctx: AgentContext): Promise<void> {
	const { sessionId, model, systemPrompt, messages, signal } = ctx
	const [providerName, modelId] = model.includes('/') ? model.split('/', 2) : ['mock', model]

	ctx.onStatus(true, 'generating...')

	try {
		const provider = await loadProvider(providerName)

		for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
			if (signal?.aborted) break

			const gen = provider.generate({ messages, model: modelId, systemPrompt, tools: TOOLS })

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
					case 'error':
						await emit(sessionId, { type: 'line', text: event.message, level: 'error' })
						break
					case 'done': {
						if (toolCalls.length === 0) {
							// No tools — persist and finish
							await appendMessages(sessionId, [
								{ role: 'assistant', text: assistantText || undefined, thinkingText: thinkingText || undefined, ts: new Date().toISOString() },
							])
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

						// Execute tools, writing each result individually
						for (const call of toolCalls) {
							if (signal?.aborted) { aborted = true; break }
							const args = argsPreview(call)
							await emit(sessionId, {
								type: 'tool', toolId: call.id, name: call.name,
								args, phase: 'running',
							})

							const onChunk = (text: string) => emit(sessionId, {
								type: 'tool', toolId: call.id, name: call.name,
								args, phase: 'streaming', output: text,
							})
							const result = await executeTool(call, onChunk)

							// Persist tool result immediately
							const toolResultEntry = await writeToolResultEntry(sessionId, call.id, result, toolRefMap)
							await appendMessages(sessionId, [toolResultEntry])

							await emit(sessionId, {
								type: 'tool', toolId: call.id, name: call.name,
								args, phase: 'done', output: result,
							})
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
								content: [{ type: 'tool_result', tool_use_id: call.id, content: block?.result?.content ?? '' }],
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
				await emit(sessionId, { type: 'line', sessionId, text: '[paused]', level: 'meta' })
				await emit(sessionId, { type: 'command', commandId: '', phase: 'done' })
				return
			}

			// If we get here, there were tool calls — loop for next round
		}

		// Exceeded max rounds
		await emit(sessionId, { type: 'line', text: `Stopped after ${MAX_TOOL_ROUNDS} tool rounds`, level: 'warn' })
		await emit(sessionId, { type: 'command', commandId: '', phase: 'done' })
	} catch (err: any) {
		await emit(sessionId, { type: 'line', text: `Error: ${err.message}`, level: 'error' })
		await emit(sessionId, { type: 'command', commandId: '', phase: 'failed', message: err.message })
	} finally {
		ctx.onStatus(false)
	}
}