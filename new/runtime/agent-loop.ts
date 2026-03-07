// Agent loop — runs a single generation for a session.
// Drives the provider, emits IPC events, persists to messages.asonl.
// Supports tool execution with re-invoke loop.

import { loadProvider, type ProviderEvent } from './provider.ts'
import { events } from '../ipc.ts'
import { appendMessages, type AssistantMessage } from '../session/messages.ts'
import { eventId } from '../protocol.ts'
import type { RuntimeEvent } from '../protocol.ts'

const TOOLS = [
	{ name: 'bash', description: 'Run a bash command', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
	{ name: 'read', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' }, start: { type: 'integer' }, end: { type: 'integer' } }, required: ['path'] } },
	{ name: 'write', description: 'Create or overwrite a file', input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
]

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

// ── Tool execution ──

interface ToolCall { id: string; name: string; input: unknown }
interface ToolResult { id: string; name: string; input: unknown; result: string }

async function executeTool(call: ToolCall): Promise<string> {
	const inp = call.input as any
	switch (call.name) {
		case 'bash': {
			const cmd = String(inp?.command ?? '')
			if (!cmd) return '(empty command)'
			const proc = Bun.spawn(['sh', '-c', cmd], {
				stdout: 'pipe', stderr: 'pipe',
				env: { ...process.env, TERM: 'dumb' },
			})
			const [stdout, stderr] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			])
			const code = await proc.exited
			let out = stdout
			if (stderr) out += (out ? '\n' : '') + stderr
			if (code !== 0) out += `\n[exit ${code}]`
			return out.slice(0, 10000) || '(no output)'
		}
		case 'read': {
			const path = String(inp?.path ?? '')
			if (!path) return '(no path)'
			try {
				const text = await Bun.file(path).text()
				return text.slice(0, 10000)
			} catch (e: any) {
				return `Error: ${e.message}`
			}
		}
		case 'write': {
			const path = String(inp?.path ?? '')
			const content = String(inp?.content ?? '')
			if (!path) return '(no path)'
			try {
				await Bun.write(path, content)
				return `Wrote ${content.length} bytes to ${path}`
			} catch (e: any) {
				return `Error: ${e.message}`
			}
		}
		default:
			return `Unknown tool: ${call.name}`
	}
}

function argsPreview(call: ToolCall): string {
	const inp = call.input as any
	switch (call.name) {
		case 'bash': return String(inp?.command ?? '')
		case 'read': return String(inp?.path ?? '')
		case 'write': return String(inp?.path ?? '')
		default: return JSON.stringify(call.input)
	}
}

// ── Agent loop ──

const MAX_TOOL_ROUNDS = 10

export async function runAgentLoop(ctx: AgentContext): Promise<void> {
	const { sessionId, model, systemPrompt, messages } = ctx
	const [providerName, modelId] = model.includes('/') ? model.split('/', 2) : ['mock', model]

	ctx.onStatus(true, 'generating...')

	try {
		const provider = await loadProvider(providerName)

		for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
			const gen = provider.generate({ messages, model: modelId, systemPrompt, tools: TOOLS })

			let thinkingText = ''
			let assistantText = ''
			const toolCalls: ToolCall[] = []

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
						toolCalls.push({ id: event.id, name: event.name, input: event.input })
						break
					case 'error':
						await emit(sessionId, { type: 'line', text: event.message, level: 'error' })
						break
					case 'done': {
						if (toolCalls.length === 0) {
							// No tools — persist and finish
							const entry: AssistantMessage = { role: 'assistant', ts: new Date().toISOString() }
							if (assistantText) entry.text = assistantText
							if (thinkingText) entry.thinkingText = thinkingText
							await appendMessages(sessionId, [entry])
							await emit(sessionId, {
								type: 'command', commandId: '', phase: 'done',
								message: event.usage ? `${event.usage.input}→${event.usage.output} tokens` : undefined,
							})
							return
						}

						// Execute tools
						const toolResults: ToolResult[] = []
						for (const call of toolCalls) {
							const args = argsPreview(call)
							const startTime = Date.now()
							await emit(sessionId, {
								type: 'tool', toolId: call.id, name: call.name,
								args, phase: 'running',
							})

							const result = await executeTool(call)
							toolResults.push({ ...call, result })

							await emit(sessionId, {
								type: 'tool', toolId: call.id, name: call.name,
								args, phase: 'done', output: result,
							})
						}

						// Persist assistant message with tools
						const entry: AssistantMessage = { role: 'assistant', ts: new Date().toISOString() }
						if (assistantText) entry.text = assistantText
						if (thinkingText) entry.thinkingText = thinkingText
						entry.tools = toolResults.map(t => ({
							id: t.id, name: t.name, input: t.input, result: t.result,
						}))
						await appendMessages(sessionId, [entry])

						// Add tool results to messages for next round
						messages.push({
							role: 'assistant',
							content: [
								...(assistantText ? [{ type: 'text', text: assistantText }] : []),
								...toolCalls.map(t => ({
									type: 'tool_use', id: t.id, name: t.name, input: t.input,
								})),
							],
						})
						for (const tr of toolResults) {
							messages.push({
								role: 'user',
								content: [{ type: 'tool_result', tool_use_id: tr.id, content: tr.result }],
							})
						}

						break
					}
				}
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
