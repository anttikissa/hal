// Agent loop — runs a single generation for a session.
// Drives the provider, emits IPC events, persists to history.asonl.
// Supports tool execution with re-invoke loop.

import { loader } from '../providers/loader.ts'
import type { ProviderEvent } from '../providers/provider.ts'
import { ipc } from '../ipc.ts'
import { history as sessionHistory } from '../session/history.ts'
import { blob } from '../session/blob.ts'
import { attachments } from '../session/attachments.ts'
import { protocol } from '../protocol.ts'
import type { RuntimeEvent, EventLevel } from '../protocol.ts'
import { tools, type ToolCall } from './tools.ts'
import type { EvalContext } from './eval-tool.ts'
import { hooks } from './hooks.ts'
import { context } from './context.ts'
import { config, type PermissionLevel } from '../config.ts'
import { blink } from './blink.ts'

const WRITE_TOOLS = new Set(['bash', 'write', 'edit', 'eval'])
const READ_TOOLS = new Set(['read', 'grep', 'glob', 'ls', 'web_search'])

function needsPermission(toolName: string, level: PermissionLevel | undefined): boolean {
	if (!level || level === 'yolo') return false
	if (level === 'ask-writes') return WRITE_TOOLS.has(toolName)
	return WRITE_TOOLS.has(toolName) || READ_TOOLS.has(toolName)
}

export interface AgentContext {
	sessionId: string
	model: string
	systemPrompt: string
	messages: any[]
	onStatus: (busy: boolean, activity?: string, context?: { used: number; max: number; estimated?: boolean }) => void
	askUser: (question: string) => Promise<string>
	signal?: AbortSignal
	onDestructiveToolStart?: (toolId: string, toolName: string) => void
	onDestructiveToolEnd?: (toolId: string, toolName: string) => void
}

function emit(sessionId: string, event: Partial<RuntimeEvent> & { type: RuntimeEvent['type'] }): Promise<void> {
	return ipc.events.append({
		id: protocol.eventId(), sessionId, createdAt: new Date().toISOString(), ...event,
	} as RuntimeEvent)
}

/** Emit IPC line event AND persist as info message. */
async function emitInfo(sessionId: string, text: string, level: EventLevel, detail?: string): Promise<void> {
	await sessionHistory.appendHistory(sessionId, [{ type: 'info', text, level, detail, ts: new Date().toISOString() }])
	await emit(sessionId, { type: 'line', text, level, detail })
}

export async function runAgentLoop(ctx: AgentContext): Promise<void> {
	const { sessionId, model, systemPrompt, messages, signal } = ctx
	const [providerName, modelId] = model.includes('/') ? model.split('/', 2) : ['mock', model]
	const ctxMax = context.contextWindowForModel(modelId)
	let calibrated = context.isCalibrated(modelId)

	const cfg = config.getConfig()
	const evalEnabled = !!cfg.eval
	const availableTools = tools.getTools(evalEnabled)
	const evalCtx: EvalContext | undefined = evalEnabled ? {
		sessionId,
		halDir: process.env.HAL_DIR ?? process.cwd(),
		stateDir: process.env.HAL_STATE_DIR ?? `${process.env.HAL_DIR ?? process.cwd()}/state`,
		cwd: process.env.LAUNCH_CWD ?? process.cwd(),
		runtime: null, // set lazily below to avoid circular import at module load
	} : undefined

	const overheadBytes = systemPrompt.length + JSON.stringify(availableTools).length
	ctx.onStatus(true, 'generating...', context.estimateContext(messages, modelId, overheadBytes))

	try {
		const provider = await loader.loadProvider(providerName)

		while (!signal?.aborted) {

			const gen = provider.generate({ messages, model: modelId, systemPrompt, tools: availableTools, signal, sessionId })

			let thinkingText = ''
			let thinkingBlobId = ''
			let thinkingSignature = ''
			let assistantText = ''
			const toolCalls: ToolCall[] = []
			let aborted = false
			let persisted = false
			const blinkParser = blink.createBlinkParser()

			for await (const event of gen) {
				if (signal?.aborted) { aborted = true; break }
				switch (event.type) {
					case 'thinking':
						if (!thinkingBlobId) thinkingBlobId = blob.makeId(sessionId)
						thinkingText += event.text
						await emit(sessionId, { type: 'chunk', text: event.text, channel: 'thinking', blobId: thinkingBlobId })
						break
					case 'thinking_signature':
						thinkingSignature = event.signature
						break
					case 'text':
						for (const seg of blinkParser.feed(event.text)) {
							if (seg.type === 'text') {
								assistantText += seg.text
								await emit(sessionId, { type: 'chunk', text: seg.text!, channel: 'assistant' })
							} else {
								await new Promise(r => setTimeout(r, seg.ms!))
							}
						}
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
						// Flush any buffered blink text
						for (const seg of blinkParser.flush()) {
							if (seg.type === 'text') {
								assistantText += seg.text
								await emit(sessionId, { type: 'chunk', text: seg.text!, channel: 'assistant' })
							}
						}
						// Calibrate bytes→tokens ratio on first API response
						if (!calibrated && event.usage && event.usage.input > 0) {
							calibrated = true
							let totalBytes = systemPrompt.length + JSON.stringify(availableTools).length
							for (const m of messages) totalBytes += context.messageBytes(m)
							context.saveCalibration(modelId, totalBytes, event.usage.input)
						}
						const usage = event.usage
						const assistantOpts = {
							text: assistantText || undefined,
							thinkingText: thinkingText || undefined,
							thinkingBlobId: thinkingBlobId || undefined,
							thinkingSignature: thinkingSignature || undefined,
							toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
							usage,
						}

						if (toolCalls.length === 0) {
							// No tools — persist and finish
							const { entry } = await sessionHistory.writeAssistantEntry(sessionId, assistantOpts)
							await sessionHistory.appendHistory(sessionId, [entry])
							if (event.usage) ctx.onStatus(true, undefined, { used: event.usage.input, max: ctxMax })
							await emit(sessionId, {
								type: 'command', commandId: '', phase: 'done',
								message: event.usage ? `${event.usage.input}→${event.usage.output} tokens` : undefined,
							})
							return
						}

						// Write assistant entry BEFORE executing tools
						const { entry: assistantEntry, toolBlobMap } = await sessionHistory.writeAssistantEntry(sessionId, assistantOpts)
						await sessionHistory.appendHistory(sessionId, [assistantEntry])
						persisted = true
						if (event.usage) ctx.onStatus(true, undefined, { used: event.usage.input, max: ctxMax })

						// Execute tools in parallel
						const toolResults = await Promise.all(toolCalls.map(async (originalCall) => {
							if (signal?.aborted) return { call: originalCall, result: '[interrupted]' as string | any[], toolStatus: 'done' as const }
							let call = hooks.runHooks(originalCall)
							if (call.input !== originalCall.input) {
								const blobId = toolBlobMap.get(call.id)
								if (blobId) await blob.updateInput(sessionId, blobId, call.input, originalCall.input)
							}
							const args = tools.argsPreview(call)

							let result: string | any[]
							let toolStatus: 'done' | 'error' = 'done'

							// Permission gate
							if (needsPermission(call.name, config.getConfig().permissions)) {
								const answer = await ctx.askUser(`Allow ${call.name} ${args}? (y/n)`)
								if (answer.trim().toLowerCase() !== 'y') {
									result = 'error: user denied permission'
									toolStatus = 'error'
									return { call, result, toolStatus }
								}
							}

							if (call.name === 'ask') {
								const question = (call.input as any)?.question ?? ''
								const answer = await ctx.askUser(question) || '[no answer]'
								const { apiContent } = await attachments.resolve(sessionId, answer)
								result = apiContent
							} else {
								const blobId = toolBlobMap.get(call.id)
								await emit(sessionId, {
									type: 'tool', toolId: call.id, name: call.name,
									args, phase: 'running', blobId,
								})
								const onChunk = (text: string) => emit(sessionId, {
									type: 'tool', toolId: call.id, name: call.name,
									args, phase: 'streaming', output: text,
								})
								const destructive = call.name === 'bash' || call.name === 'write' || call.name === 'edit'
								if (destructive) ctx.onDestructiveToolStart?.(call.id, call.name)
								try {
									result = await tools.executeTool(call, onChunk, { evalCtx, sessionId, signal })
								} finally {
									if (destructive) ctx.onDestructiveToolEnd?.(call.id, call.name)
								}
								if (typeof result === 'string' && result.startsWith('error:')) toolStatus = 'error'
								await emit(sessionId, {
									type: 'tool', toolId: call.id, name: call.name,
									args,
									phase: toolStatus === 'error' ? 'error' : 'done',
									output: typeof result === 'string' ? result : '[non-text output]',
									blobId,
								})
							}

							return { call, result, toolStatus }
						}))

						// Persist all tool results
						if (!signal?.aborted) {
							const entries = []
							for (const { call, result, toolStatus } of toolResults) {
								entries.push(await sessionHistory.writeToolResultEntry(sessionId, call.id, result, toolBlobMap, toolStatus))
							}
							await sessionHistory.appendHistory(sessionId, entries)
						} else {
							aborted = true
						}

						if (aborted) break

						// Add to messages for next round
						messages.push({
							role: 'assistant',
							content: [
								...(thinkingText && thinkingSignature ? [{ type: 'thinking', thinking: thinkingText, signature: thinkingSignature }] : []),
								...(assistantText ? [{ type: 'text', text: assistantText }] : []),
								...toolCalls.map(t => ({
									type: 'tool_use', id: t.id, name: t.name, input: t.input,
								})),
							],
						})
						for (const call of toolCalls) {
							const blobId = toolBlobMap.get(call.id)!
							const block = await blob.read(sessionId, blobId)
							const raw = block?.result?.content ?? ''
							const content = typeof raw === 'string' ? tools.truncate(raw) : raw
							messages.push({
								role: 'user',
								content: [{ type: 'tool_result', tool_use_id: call.id, content }],
							})
						}

						break
					}
				}
			}

			if (aborted) {
				// Persist partial output before exiting (skip if already written in tool path)
				if (!persisted && (assistantText || thinkingText)) {
					const { entry } = await sessionHistory.writeAssistantEntry(sessionId, {
						text: assistantText || undefined,
						thinkingText: thinkingText || undefined,
						thinkingBlobId: thinkingBlobId || undefined,
						thinkingSignature: thinkingSignature || undefined,
					})
					await sessionHistory.appendHistory(sessionId, [entry])
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
		await emitInfo(sessionId, '/continue to retry', 'meta')
		await emit(sessionId, { type: 'command', commandId: '', phase: 'failed', message: err.message })
	} finally {
		ctx.onStatus(false)
	}
}

export const agentLoop = { runAgentLoop }