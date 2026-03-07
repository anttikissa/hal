// Agent loop — runs a single generation for a session.
// Drives the provider, emits IPC events, persists to messages.asonl.

import { loadProvider, type ProviderEvent } from './provider.ts'
import { events } from '../ipc.ts'
import { appendMessages, type AssistantMessage } from '../session/messages.ts'
import { eventId } from '../protocol.ts'
import type { RuntimeEvent } from '../protocol.ts'

export interface AgentContext {
	sessionId: string
	model: string
	systemPrompt: string
	messages: any[]
	onStatus: (busy: boolean, activity?: string) => void
}

function emit(sessionId: string, event: Partial<RuntimeEvent> & { type: RuntimeEvent['type'] }): Promise<void> {
	return events.append({
		id: eventId(), sessionId, createdAt: new Date().toISOString(), ...event,
	} as RuntimeEvent)
}

export async function runAgentLoop(ctx: AgentContext): Promise<void> {
	const { sessionId, model, systemPrompt, messages } = ctx
	const [providerName, modelId] = model.includes('/') ? model.split('/', 2) : ['mock', model]

	ctx.onStatus(true, 'generating...')

	try {
		const provider = await loadProvider(providerName)
		const gen = provider.generate({ messages, model: modelId, systemPrompt })

		let thinkingText = ''
		let assistantText = ''

		for await (const event of gen) {
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
					// TODO: tool execution
					await emit(sessionId, {
						type: 'line', text: `[tool_call] ${event.name}(...)`, level: 'tool',
					})
					break
				case 'error':
					await emit(sessionId, { type: 'line', text: event.message, level: 'error' })
					break
				case 'done': {
					// Persist assistant message
					const entry: AssistantMessage = {
						role: 'assistant',
						ts: new Date().toISOString(),
					}
					if (assistantText) entry.text = assistantText
					if (thinkingText) entry.thinkingText = thinkingText
					await appendMessages(sessionId, [entry])

					// Signal done
					await emit(sessionId, {
						type: 'command', commandId: '', phase: 'done',
						message: event.usage ? `${event.usage.input}→${event.usage.output} tokens` : undefined,
					})
					break
				}
			}
		}
	} catch (err: any) {
		await emit(sessionId, { type: 'line', text: `Error: ${err.message}`, level: 'error' })
		await emit(sessionId, { type: 'command', commandId: '', phase: 'failed', message: err.message })
	} finally {
		ctx.onStatus(false)
	}
}
