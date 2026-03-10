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
const PREVIEW = 56

type SourceEntry = {
	line: number
	msg: any
}

type OutRow = {
	line: number
	type: string
	detail: string
	bytes: number
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, ' ').trim()
}

function clip(text: string, max: number): string {
	if (text.length <= max) return text
	if (max <= 3) return '.'.repeat(max)
	return `${text.slice(0, max - 3)}...`
}

function textBytes(value: string): number {
	return Buffer.byteLength(value, 'utf8')
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

function describeSkipped(msg: any, beforeReplayStart: boolean): { type: string; detail: string } {
	const type = msg.role ?? msg.type ?? 'unknown'
	if (beforeReplayStart) return { type, detail: '[before replay start]' }
	if (msg.type === 'info') return { type: 'info', detail: '[info line, not sent]' }
	if (msg.type === 'reset' || msg.type === 'handoff') return { type, detail: '[replay marker, not sent]' }
	if (msg.type === 'forked_from') return { type, detail: '[fork marker, not sent]' }
	return { type, detail: '[compacted / not sent]' }
}

function findReplayStart(entries: SourceEntry[]): number {
	for (let i = entries.length - 1; i >= 0; i--) {
		const m = entries[i].msg
		if (m?.type === 'reset' || m?.type === 'handoff') return i + 1
	}
	return 0
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


function toolUseDetail(name: string, command?: string): string {
	if (!command) return `${name}`
	return `${name} '${clip(oneLine(command), PREVIEW)}'`
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

function modelForContext(meta: any): string {
	return (meta?.model as string | undefined) ?? getConfig().defaultModel
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
	const replay = entries.slice(replayStart)

	const out: any[] = []
	const toolMeta = new Map<string, { name: string; command?: string }>()

	for (const src of replay) {
		const msg = src.msg
		if (msg?.role === 'user') {
			if (typeof msg.content === 'string') {
				out.push({ role: 'user', content: msg.content, _line: src.line })
			} else if (Array.isArray(msg.content)) {
				const blocks: any[] = []
				for (const b of msg.content) {
					if (b?.type === 'image' && b.ref) {
						const data = await readBlock(sessionId, b.ref)
						if (data?.media_type && data?.data) {
							blocks.push({
								type: 'image',
								source: { type: 'base64', media_type: data.media_type, data: data.data },
								_line: src.line,
							})
						}
					} else {
						blocks.push({ ...b, _line: src.line })
					}
				}
				out.push({ role: 'user', content: blocks, _line: src.line })
			}
			continue
		}

		if (msg?.role === 'assistant') {
			const content: any[] = []
			if (msg.thinkingText && msg.thinkingSignature) {
				content.push({ type: 'thinking', thinking: msg.thinkingText, signature: msg.thinkingSignature, _line: src.line })
			}
			if (msg.text) content.push({ type: 'text', text: msg.text, _line: src.line })
			if (Array.isArray(msg.tools)) {
				for (const t of msg.tools) {
					const block = await readBlock(sessionId, t.ref)
					const input = block?.call?.input ?? {}
					const command = resolveCommand(t.name, input)
					toolMeta.set(t.id, { name: t.name, command })
					content.push({ type: 'tool_use', id: t.id, name: t.name, input, _line: src.line, _command: command })
				}
			}
			if (content.length > 0) out.push({ role: 'assistant', content, _line: src.line })
			continue
		}

		if (msg?.role === 'tool_result') {
			const block = await readBlock(sessionId, msg.ref)
			let content = block?.result?.content ?? '[interrupted]'
			if (typeof content === 'string' && content.length > MAX_API_OUTPUT) {
				content = `${content.slice(0, MAX_API_OUTPUT)}\n[truncated ${content.length - MAX_API_OUTPUT} chars]`
			}
			const tName = block?.call?.name ?? toolMeta.get(msg.tool_use_id)?.name ?? 'tool'
			const command = resolveCommand(tName, block?.call?.input) ?? toolMeta.get(msg.tool_use_id)?.command
			out.push({
				role: 'user',
				content: [{ type: 'tool_result', tool_use_id: msg.tool_use_id, content, _ref: msg.ref, _line: src.line, _toolName: tName, _command: command }],
				_line: src.line,
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
				_line: b._line ?? msg._line,
				_toolName: b.name,
				_command: b._command,
			})),
			_line: msg._line,
		}
		out.splice(i + 1, 0, synthetic)
		i++
	}

	const compacted = compactApiMessages(out)

	const rows: OutRow[] = []
	const linesWithOutgoing = new Set<number>()

	for (const msg of compacted) {
		if (msg.role === 'user') {
			if (typeof msg.content === 'string') {
				const line = Number(msg._line ?? 0)
				rows.push({ line, type: 'user', detail: `'${clip(oneLine(msg.content), PREVIEW)}'`, bytes: textBytes(msg.content) })
				if (line > 0) linesWithOutgoing.add(line)
				continue
			}
			if (Array.isArray(msg.content)) {
				for (const block of msg.content) {
					const line = Number(block?._line ?? msg._line ?? 0)
					if (block?.type === 'tool_result') {
						const content = block.content
						const bytes = typeof content === 'string' ? textBytes(content) : jsonBytes(content)
						const detail = toolResultDetail(block._toolName ?? 'tool', block._command, content)
						rows.push({ line, type: 'tool_result', detail, bytes })
					} else if (block?.type === 'text') {
						const text = String(block.text ?? '')
						rows.push({ line, type: 'user', detail: `'${clip(oneLine(text), PREVIEW)}'`, bytes: textBytes(text) })
					} else if (block?.type === 'image') {
						rows.push({ line, type: 'user_image', detail: '[image]', bytes: jsonBytes(block.source ?? block) })
					}
					if (line > 0) linesWithOutgoing.add(line)
				}
			}
			continue
		}

		if (msg.role === 'assistant' && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				const line = Number(block?._line ?? msg._line ?? 0)
				if (block?.type === 'text') {
					const text = String(block.text ?? '')
					rows.push({ line, type: 'assistant_text', detail: `'${clip(oneLine(text), PREVIEW)}'`, bytes: textBytes(text) })
				} else if (block?.type === 'thinking') {
					const thinking = String(block.thinking ?? '')
					rows.push({ line, type: 'thinking', detail: `${lineCount(thinking)} lines`, bytes: textBytes(thinking) })
				} else if (block?.type === 'tool_use') {
					const detail = toolUseDetail(block.name ?? 'tool', block._command)
					rows.push({ line, type: 'tool_use', detail, bytes: jsonBytes(block.input ?? {}) })
				}
				if (line > 0) linesWithOutgoing.add(line)
			}
		}
	}

	for (let i = 0; i < entries.length; i++) {
		const src = entries[i]
		if (linesWithOutgoing.has(src.line)) continue
		const skipped = describeSkipped(src.msg, i < replayStart)
		rows.push({ line: src.line, type: skipped.type, detail: skipped.detail, bytes: 0 })
	}

	rows.sort((a, b) => (a.line - b.line) || a.type.localeCompare(b.type))

	const totalBytes = rows.reduce((sum, r) => sum + r.bytes, 0)
	const serializedMessagesBytes = jsonBytes(compacted)
	const systemPrompt = loadSystemPrompt({ model, sessionDir: sessionId })
	const approxRequestBytes = serializedMessagesBytes + systemPrompt.bytes
	const ctxMax = contextWindowForModel(modelId)

	console.log(`session: ${sessionId}`)
	console.log(`model:   ${model} (window ${ctxMax.toLocaleString()})`)
	console.log(`log:     ${logPath}`)
	console.log(`records: ${entries.length} (replay starts at line ${entries[replayStart]?.line ?? 'start'})`)
	console.log('')
	console.log('line | type          | detail                                                     | bytes')
	console.log('-----+---------------+------------------------------------------------------------+----------')
	for (const row of rows) {
		const line = String(row.line).padStart(4)
		const type = row.type.padEnd(13)
		const detail = clip(oneLine(row.detail), 60).padEnd(60)
		const bytes = String(row.bytes).padStart(8)
		console.log(`${line} | ${type} | ${detail} | ${bytes}`)
	}

	console.log('')
	console.log(`message bytes (sum of listed rows): ${totalBytes.toLocaleString()}`)
	console.log(`messages JSON bytes (compacted replay): ${serializedMessagesBytes.toLocaleString()}`)
	console.log(`system prompt bytes: ${systemPrompt.bytes.toLocaleString()} (${systemPrompt.loaded.join(', ')})`)
	console.log(`approx request bytes now: ${approxRequestBytes.toLocaleString()}`)
}

main().catch(err => {
	console.error(`error: ${err?.message ?? err}`)
	process.exit(1)
})
