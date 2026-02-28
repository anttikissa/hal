#!/usr/bin/env bun
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { loadAuth } from './src/auth.ts'

type ToolCall = {
	id: string
	name: string
	arguments: string
}

type StreamResult = {
	text: string
	toolCalls: ToolCall[]
	usage: any
	finishReason: string
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1'
const DEFAULT_MODEL = 'gpt-4.1-mini'
const DEFAULT_MAX_TOKENS = 1200

const baseUrl = (process.env.OPENAI_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
const model = process.env.OPENAI_MODEL ?? DEFAULT_MODEL
const maxTokens = Number.parseInt(process.env.OPENAI_MAX_TOKENS ?? `${DEFAULT_MAX_TOKENS}`, 10)
const systemPrompt = process.env.OPENAI_SYSTEM?.trim()

const auth = loadAuth().openai
const token =
	process.env.OPENAI_API_KEY ??
	process.env.OPENAI_TOKEN ??
	auth?.apiKey ??
	auth?.accessToken ??
	''

const headers: Record<string, string> = {
	'Content-Type': 'application/json',
	accept: 'text/event-stream',
}
if (token) headers.Authorization = `Bearer ${token}`

const tools = [
	{
		type: 'function',
		function: {
			name: 'read',
			description: 'Read a file from disk. Returns file contents.',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string' },
				},
				required: ['path'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'bash',
			description: 'Run a shell command. Returns stdout + stderr.',
			parameters: {
				type: 'object',
				properties: {
					command: { type: 'string' },
				},
				required: ['command'],
			},
		},
	},
]

function sseData(eventChunk: string): string {
	const dataLines: string[] = []
	for (const line of eventChunk.split('\n')) {
		if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
	}
	return dataLines.join('\n')
}

async function streamChat(messages: any[]): Promise<StreamResult> {
	const body: any = {
		model,
		messages,
		stream: true,
		max_tokens: maxTokens,
		tools,
		tool_choice: 'auto',
		parallel_tool_calls: true,
		stream_options: { include_usage: true },
	}

	const res = await fetch(`${baseUrl}/chat/completions`, {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
	})

	if (!res.ok || !res.body) {
		const text = await res.text().catch(() => '')
		throw new Error(`${res.status} ${res.statusText}${text ? `\n${text}` : ''}`)
	}

	const reader = res.body.getReader()
	const decoder = new TextDecoder()

	let buffer = ''
	let text = ''
	let usage: any = null
	let finishReason = ''
	const toolCallsByIndex = new Map<number, ToolCall>()

	while (true) {
		const { done, value } = await reader.read()
		if (done) break
		buffer += decoder.decode(value, { stream: true })

		let boundary = -1
		while ((boundary = buffer.indexOf('\n\n')) !== -1) {
			const eventChunk = buffer.slice(0, boundary)
			buffer = buffer.slice(boundary + 2)

			const payload = sseData(eventChunk)
			if (!payload) continue
			if (payload === '[DONE]') continue

			let event: any
			try {
				event = JSON.parse(payload)
			} catch {
				console.log('\n[raw-sse]')
				console.log(payload)
				continue
			}

			if (event?.error) {
				throw new Error(JSON.stringify(event.error))
			}

			if (event?.usage && typeof event.usage === 'object') usage = event.usage

			for (const choice of Array.isArray(event?.choices) ? event.choices : []) {
				const delta = choice?.delta ?? {}

				if (typeof delta.content === 'string' && delta.content.length > 0) {
					stdout.write(delta.content)
					text += delta.content
				}

				for (const toolCallDelta of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
					const idx = Number.isInteger(toolCallDelta?.index) ? toolCallDelta.index : 0
					const existing = toolCallsByIndex.get(idx) ?? {
						id: `tool_${idx}`,
						name: '',
						arguments: '',
					}

					if (typeof toolCallDelta?.id === 'string' && toolCallDelta.id)
						existing.id = toolCallDelta.id
					if (
						typeof toolCallDelta?.function?.name === 'string' &&
						toolCallDelta.function.name
					)
						existing.name = toolCallDelta.function.name
					if (typeof toolCallDelta?.function?.arguments === 'string')
						existing.arguments += toolCallDelta.function.arguments

					toolCallsByIndex.set(idx, existing)
				}

				if (typeof choice?.finish_reason === 'string' && choice.finish_reason)
					finishReason = choice.finish_reason
			}
		}
	}

	if (text.length > 0) stdout.write('\n')

	const toolCalls = [...toolCallsByIndex.entries()]
		.sort(([a], [b]) => a - b)
		.map(([, call]) => call)

	return { text: text.trimEnd(), toolCalls, usage, finishReason }
}

function prettyArgs(raw: string): string {
	const trimmed = raw.trim()
	if (!trimmed) return '(no arguments)'
	try {
		return JSON.stringify(JSON.parse(trimmed), null, 2)
	} catch {
		return trimmed
	}
}

const history: any[] = []
if (systemPrompt) history.push({ role: 'system', content: systemPrompt })

console.log(`[test-openai] POST ${baseUrl}/chat/completions`)
console.log(`[test-openai] model=${model} max_tokens=${maxTokens} tools=${tools.length}`)
console.log(`[test-openai] auth=${token ? 'present' : 'missing'} (no login flow in this script)`)
console.log('Type a prompt. /exit to quit.')

const rl = createInterface({ input: stdin, output: stdout })

while (true) {
	let line = ''
	try {
		line = (await rl.question('\n> ')).trim()
	} catch (error: any) {
		if (error?.code === 'ERR_USE_AFTER_CLOSE') break
		throw error
	}
	if (!line) continue
	if (line === '/exit' || line === '/quit') break

	history.push({ role: 'user', content: line })

	try {
		const result = await streamChat(history)
		const assistant: any = { role: 'assistant', content: result.text }

		if (result.toolCalls.length > 0) {
			assistant.tool_calls = result.toolCalls.map((call) => ({
				id: call.id,
				type: 'function',
				function: {
					name: call.name,
					arguments: call.arguments,
				},
			}))
		}

		history.push(assistant)

		if (result.toolCalls.length > 0) {
			console.log('\n[tool calls]')
			for (const call of result.toolCalls) {
				console.log(`- ${call.name || '(unknown)'} id=${call.id}`)
				console.log(prettyArgs(call.arguments))
				const toolResult = '[test-openai] tool execution disabled (debug-only stub)'
				history.push({ role: 'tool', tool_call_id: call.id, content: toolResult })
				console.log(`  -> ${toolResult}`)
			}
		}

		if (result.usage) console.log(`[usage] ${JSON.stringify(result.usage)}`)
		if (result.finishReason) console.log(`[stop] ${result.finishReason}`)
	} catch (error: any) {
		console.log(`\n[error] ${error?.message ?? error}`)
	}
}

rl.close()
console.log('bye')
