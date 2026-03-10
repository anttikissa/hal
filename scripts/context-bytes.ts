#!/usr/bin/env bun

import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { getConfig } from '../src/config.ts'
import { contextWindowForModel } from '../src/runtime/context.ts'
import { loadSystemPrompt } from '../src/runtime/system-prompt.ts'
import { compactApiMessages } from '../src/session/compact.ts'
import { readBlock } from '../src/session/messages.ts'
import { STATE_DIR, sessionDir } from '../src/state.ts'
import { parse, parseAll } from '../src/utils/ason.ts'

const MAX_API_OUTPUT = 50_000
const PREVIEW = 72

type SourceEntry = {
	line: number
	msg: any
}

type CallRow = {
	call: number
	line: number
	trigger: string
	detail: string
	contextBytes: number
	delta: number
	sentTotal: number
	apiMessages: number
	sourceLines: string
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, ' ').trim()
}

function clip(text: string, max: number): string {
	if (text.length <= max) return text
	if (max <= 3) return '.'.repeat(max)
	return `${text.slice(0, max - 3)}...`
}

function jsonBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function lineCount(text: string): number {
	if (!text) return 0
	return text.split('\n').length
}

function resolveCommand(name: string, input: any): string | undefined {
	if (!input || typeof input !== 'object') return undefined
	if (name === 'bash' && typeof input.command === 'string') return input.command
	return undefined
}

async function resolveSessionId(arg?: string): Promise<string> {
	if (arg) return arg
	const statePath = `${STATE_DIR}/ipc/state.ason`
	if (existsSync(statePath)) {
		const state = parse(await readFile(statePath, 'utf8')) as any
		if (typeof state?.activeSessionId === 'string' && state.activeSessionId) return state.activeSessionId
	}
	throw new Error('No active session found. Pass a session id: bun scripts/context-bytes.ts <sessionId>')
}

async function resolveLogName(sessionId: string): Promise<string> {
	const metaPath = `${sessionDir(sessionId)}/meta.ason`
	if (!existsSync(metaPath)) return 'messages.asonl'
	try {
		const meta = parse(await readFile(metaPath, 'utf8')) as any
		if (typeof meta?.log === 'string' && meta.log) return meta.log
	} catch {}
	return 'messages.asonl'
}

function mapLineNumbers(raw: string, valueCount: number): number[] {
	const lines = raw.split('\n')
	const nonEmpty: number[] = []
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].trim()) nonEmpty.push(i + 1)
	}
	if (nonEmpty.length === valueCount) return nonEmpty
	return Array.from({ length: valueCount }, (_, i) => i + 1)
}

function findReplayStart(entries: SourceEntry[]): number {
	for (let i = entries.length - 1; i >= 0; i--) {
		const m = entries[i].msg
		if (m?.type === 'reset' || m?.type === 'handoff') return i + 1
	}
	return 0
}

function modelForContext(meta: any): string {
	return (meta?.model as string | undefined) ?? getConfig().defaultModel
}

function triggerKind(msg: any): string {
	if (msg?.role === 'user') return 'user'
	if (msg?.role === 'tool_result') return 'tool_result'
	if (msg?.type === 'info') return 'info'
	return msg?.role ?? msg?.type ?? 'unknown'
}

function userDetail(msg: any): string {
	if (typeof msg?.content === 'string') return `user '${clip(oneLine(msg.content), PREVIEW)}'`
	if (!Array.isArray(msg?.content)) return 'user [empty]'
	const parts: string[] = []
	for (const b of msg.content) {
		if (b?.type === 'text' && typeof b.text === 'string') parts.push(`'${clip(oneLine(b.text), PREVIEW)}'`)
		if (b?.type === 'image' && typeof b.ref === 'string') parts.push(`[image ${b.ref}]`)
	}
	if (parts.length === 0) return 'user [blocks]'
	return `user ${parts.join(' + ')}`
}

function toolResultDetail(name: string, command: string | undefined, content: unknown): string {
	if (name === 'bash') {
		const cmd = command ? `'${clip(oneLine(command), PREVIEW)}'` : '[no command]'
		if (typeof content === 'string') return `bash ${cmd} - ${lineCount(content)} lines`
		return `bash ${cmd} - [non-text output]`
	}
	if (typeof content === 'string') return `${name} - ${lineCount(content)} lines`
	return `${name} - [non-text output]`
}

function sourceLineSummary(entries: SourceEntry[]): string {
	const lines = entries
		.filter((e) => e.msg?.role === 'user' || e.msg?.role === 'assistant' || e.msg?.role === 'tool_result')
		.map((e) => e.line)
	if (lines.length === 0) return '-'
	const uniq = [...new Set(lines)]
	const first = uniq[0]
	const last = uniq[uniq.length - 1]
	if (first === last) return `${first} (${uniq.length})`
	return `${first}-${last} (${uniq.length})`
}

function pickTriggerIndex(entries: SourceEntry[], start: number, end: number): number {
	let infoIdx = -1
	for (let i = end - 1; i >= start; i--) {
		const m = entries[i].msg
		if (m?.role === 'user' || m?.role === 'tool_result') return i
		if (infoIdx === -1 && m?.type === 'info') infoIdx = i
	}
	return infoIdx
}

async function readBlockCached(sessionId: string, ref: string, cache: Map<string, any | null>): Promise<any | null> {
	const key = `${sessionId}:${ref}`
	if (cache.has(key)) return cache.get(key) ?? null
	const block = await readBlock(sessionId, ref)
	cache.set(key, block)
	return block
}

async function buildApiMessages(sessionId: string, entries: SourceEntry[], blockCache: Map<string, any | null>): Promise<any[]> {
	const out: any[] = []
	const toolMeta = new Map<string, { name: string; command?: string }>()

	for (const src of entries) {
		const msg = src.msg
		if (msg?.role === 'user') {
			if (typeof msg.content === 'string') {
				out.push({ role: 'user', content: msg.content })
			} else if (Array.isArray(msg.content)) {
				const blocks: any[] = []
				for (const b of msg.content) {
					if (b?.type === 'image' && b.ref) {
						const data = await readBlockCached(sessionId, b.ref, blockCache)
						if (data?.media_type && data?.data) {
							blocks.push({
								type: 'image',
								source: { type: 'base64', media_type: data.media_type, data: data.data },
								_ref: b.ref,
							})
						}
					} else {
						blocks.push({ ...b })
					}
				}
				out.push({ role: 'user', content: blocks })
			}
			continue
		}

		if (msg?.role === 'assistant') {
			const content: any[] = []
			if (msg.thinkingText && msg.thinkingSignature) {
				content.push({ type: 'thinking', thinking: msg.thinkingText, signature: msg.thinkingSignature })
			}
			if (msg.text) content.push({ type: 'text', text: msg.text })
			if (Array.isArray(msg.tools)) {
				for (const t of msg.tools) {
					const block = await readBlockCached(sessionId, t.ref, blockCache)
					const input = block?.call?.input ?? {}
					const command = resolveCommand(t.name, input)
					toolMeta.set(t.id, { name: t.name, command })
					content.push({ type: 'tool_use', id: t.id, name: t.name, input })
				}
			}
			if (content.length > 0) out.push({ role: 'assistant', content })
			continue
		}

		if (msg?.role === 'tool_result') {
			const block = await readBlockCached(sessionId, msg.ref, blockCache)
			let content = block?.result?.content ?? '[interrupted]'
			if (typeof content === 'string' && content.length > MAX_API_OUTPUT) {
				content = `${content.slice(0, MAX_API_OUTPUT)}\n[truncated ${content.length - MAX_API_OUTPUT} chars]`
			}
			const tName = block?.call?.name ?? toolMeta.get(msg.tool_use_id)?.name ?? 'tool'
			const command = resolveCommand(tName, block?.call?.input) ?? toolMeta.get(msg.tool_use_id)?.command
			out.push({
				role: 'user',
				content: [{ type: 'tool_result', tool_use_id: msg.tool_use_id, content, _ref: msg.ref, _toolName: tName, _command: command }],
			})
		}
	}

	const resultIds = new Set<string>()
	for (const msg of out) {
		if (msg.role !== 'user' || !Array.isArray(msg.content)) continue
		for (const block of msg.content) {
			if (block?.type === 'tool_result') resultIds.add(block.tool_use_id)
		}
	}
	for (let i = 0; i < out.length; i++) {
		const msg = out[i]
		if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue
		const missing = msg.content.filter((b: any) => b.type === 'tool_use' && !resultIds.has(b.id))
		if (missing.length === 0) continue
		const synthetic = {
			role: 'user',
			content: missing.map((b: any) => ({
				type: 'tool_result',
				tool_use_id: b.id,
				content: '[interrupted]',
				_toolName: b.name,
				_command: resolveCommand(b.name, b.input),
			})),
		}
		out.splice(i + 1, 0, synthetic)
		i++
	}

	const compacted = compactApiMessages(out)
	for (const msg of compacted) {
		if (msg.role !== 'user' || !Array.isArray(msg.content)) continue
		for (const block of msg.content) {
			if (block._ref) delete block._ref
			if (block._toolName) delete block._toolName
			if (block._command) delete block._command
		}
	}
	return compacted
}

async function triggerDetail(sessionId: string, msg: any, blockCache: Map<string, any | null>): Promise<string> {
	if (msg?.role === 'user') return userDetail(msg)
	if (msg?.role === 'tool_result') {
		const block = await readBlockCached(sessionId, msg.ref, blockCache)
		const tName = block?.call?.name ?? 'tool'
		const command = resolveCommand(tName, block?.call?.input)
		const content = block?.result?.content ?? '[interrupted]'
		return toolResultDetail(tName, command, content)
	}
	if (msg?.type === 'info') return `info '${clip(oneLine(String(msg.text ?? '')), PREVIEW)}'`
	return triggerKind(msg)
}

function formatInt(n: number): string {
	return n.toLocaleString('en-US')
}

function formatDelta(n: number): string {
	const sign = n >= 0 ? '+' : ''
	return `${sign}${formatInt(n)}`
}

async function main(): Promise<void> {
	const sessionId = await resolveSessionId(process.argv[2])
	const dir = sessionDir(sessionId)
	const metaPath = `${dir}/meta.ason`
	const meta = existsSync(metaPath) ? (parse(await readFile(metaPath, 'utf8')) as any) : {}
	const model = modelForContext(meta)
	const modelId = model.includes('/') ? model.split('/', 2)[1] : model

	const logName = await resolveLogName(sessionId)
	const logPath = `${dir}/${logName}`
	if (!existsSync(logPath)) throw new Error(`Log not found: ${logPath}`)

	const raw = await readFile(logPath, 'utf8')
	const parsed = parseAll(raw) as any[]
	const lineNos = mapLineNumbers(raw, parsed.length)
	const entries: SourceEntry[] = parsed.map((msg, i) => ({ msg, line: lineNos[i] }))
	const replayStart = findReplayStart(entries)
	const blockCache = new Map<string, any | null>()

	const systemPrompt = loadSystemPrompt({ model, sessionDir: sessionId })
	const rows: CallRow[] = []
	let sentTotal = 0
	let prevContextBytes = 0
	let callNo = 0
	let segmentStart = replayStart

	for (let i = replayStart; i < entries.length; i++) {
		if (entries[i].msg?.role !== 'assistant') continue
		const triggerIdx = pickTriggerIndex(entries, segmentStart, i)
		if (triggerIdx < 0) {
			segmentStart = i + 1
			continue
		}
		const prefix = entries.slice(replayStart, i)
		const apiMessages = await buildApiMessages(sessionId, prefix, blockCache)
		const contextBytes = jsonBytes(apiMessages) + systemPrompt.bytes
		const delta = contextBytes - prevContextBytes
		prevContextBytes = contextBytes
		sentTotal += contextBytes
		callNo++

		const triggerEntry = entries[triggerIdx]
		rows.push({
			call: callNo,
			line: triggerEntry.line,
			trigger: triggerKind(triggerEntry.msg),
			detail: await triggerDetail(sessionId, triggerEntry.msg, blockCache),
			contextBytes,
			delta,
			sentTotal,
			apiMessages: apiMessages.length,
			sourceLines: sourceLineSummary(prefix),
		})
		segmentStart = i + 1
	}

	const ctxMax = contextWindowForModel(modelId)
	console.log(`session: ${sessionId}`)
	console.log(`model:   ${model} (window ${ctxMax.toLocaleString('en-US')})`)
	console.log(`log:     ${logPath}`)
	console.log(`records: ${entries.length} (replay starts at line ${entries[replayStart]?.line ?? 'start'})`)
	console.log(`system prompt bytes: ${formatInt(systemPrompt.bytes)} (${systemPrompt.loaded.join(', ')})`)
	console.log('')

	if (rows.length === 0) {
		console.log('No outgoing LLM calls detected from this log.')
		return
	}

	console.log('call | line | trigger     | detail                                                               | context_bytes | delta      | sent_total  | api_msgs | src_lines')
	console.log('-----+------+-------------+----------------------------------------------------------------------+---------------+------------+-------------+----------+----------------')
	for (const row of rows) {
		const call = String(row.call).padStart(4)
		const line = String(row.line).padStart(4)
		const trigger = row.trigger.padEnd(11)
		const detail = clip(oneLine(row.detail), 68).padEnd(68)
		const contextBytes = formatInt(row.contextBytes).padStart(13)
		const delta = formatDelta(row.delta).padStart(10)
		const sent = formatInt(row.sentTotal).padStart(11)
		const apiMsgs = String(row.apiMessages).padStart(8)
		console.log(`${call} | ${line} | ${trigger} | ${detail} | ${contextBytes} | ${delta} | ${sent} | ${apiMsgs} | ${row.sourceLines}`)
	}

	console.log('')
	console.log('Notes:')
	console.log('- context_bytes = JSON(messages after compactApiMessages) + system prompt bytes for that call')
	console.log('- delta compares this call to previous call (negative delta = context shrank)')
	console.log('- src_lines shows cumulative messages.asonl source line range considered before that call')
}

main().catch(err => {
	console.error(`error: ${err?.message ?? err}`)
	process.exit(1)
})
