// Session history log — append-only ASONL per session.

import { existsSync, readFileSync } from 'fs'
import { Log } from '../utils/log.ts'
import { state } from '../state.ts'
import { ason } from '../utils/ason.ts'
import { session } from './session.ts'
import { prune } from './prune.ts'
import { historyFork } from './history-fork.ts'
import { blob } from './blob.ts'

function resolveLogName(sessionId: string): string {
	const cached = session.logNameCache.get(sessionId)
	if (cached) return cached
	const metaPath = `${state.sessionDir(sessionId)}/session.ason`
	if (existsSync(metaPath)) {
		try {
			const meta = ason.parse(readFileSync(metaPath, 'utf-8')) as any
			const name = meta?.log ?? 'history.asonl'
			session.logNameCache.set(sessionId, name)
			return name
		} catch {}
	}
	return 'history.asonl'
}

function historyLog(sessionId: string) {
	return new Log<Message>(`${state.sessionDir(sessionId)}/${resolveLogName(sessionId)}`)
}

export interface UserMessage {
	role: 'user'
	content: string | { type: 'text'; text: string }[] | { type: 'image'; blobId: string }[]
	ts: string
}

export interface AssistantMessage {
	role: 'assistant'
	text?: string
	thinkingText?: string
	thinkingSignature?: string
	thinkingBlobId?: string
	tools?: { id: string; name: string; blobId: string }[]
	usage?: { input: number; output: number }
	ts: string
}

export interface ToolResultMessage {
	role: 'tool_result'
	tool_use_id: string
	blobId: string
	ts: string
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage
	| { type: 'info'; text: string; level?: string; detail?: string; ts: string }
	| { type: 'reset'; ts: string }
	| { type: 'compact'; ts: string }
	| { type: 'forked_from'; parent: string; ts: string }

export async function getLastUsage(sessionId: string): Promise<{ input: number; output: number } | null> {
	const entries = await readHistory(sessionId)
	for (let i = entries.length - 1; i >= 0; i--) {
		const m = entries[i]
		if (m.role === 'assistant' && m.usage) return m.usage
	}
	return null
}

export async function writeAssistantEntry(
	sessionId: string,
	opts: { text?: string; thinkingText?: string; thinkingBlobId?: string; thinkingSignature?: string; toolCalls?: { id: string; name: string; input: unknown }[]; usage?: { input: number; output: number } },
): Promise<{ entry: AssistantMessage; toolBlobMap: Map<string, string> }> {
	const entry: AssistantMessage = { role: 'assistant', ts: new Date().toISOString() }
	const toolBlobMap = new Map<string, string>()
	if (opts.text) entry.text = opts.text
	if (opts.thinkingText) {
		entry.thinkingText = opts.thinkingText
		const blobId = opts.thinkingBlobId || blob.makeId(sessionId)
		entry.thinkingBlobId = blobId
		await blob.write(sessionId, blobId, { thinking: opts.thinkingText, signature: opts.thinkingSignature })
	}
	if (opts.thinkingSignature) entry.thinkingSignature = opts.thinkingSignature
	if (opts.usage) entry.usage = opts.usage
	if (opts.toolCalls && opts.toolCalls.length > 0) {
		entry.tools = []
		for (const t of opts.toolCalls) {
			const blobId = blob.makeId(sessionId)
			toolBlobMap.set(t.id, blobId)
			await blob.write(sessionId, blobId, { call: { name: t.name, input: t.input } })
			entry.tools.push({ id: t.id, name: t.name, blobId })
		}
	}
	return { entry, toolBlobMap }
}

export async function writeToolResultEntry(
	sessionId: string,
	toolUseId: string,
	output: string | any[],
	toolBlobMap: Map<string, string>,
	status: 'done' | 'error' = 'done',
): Promise<ToolResultMessage> {
	const blobId = toolBlobMap.get(toolUseId)!
	const existing = await blob.read(sessionId, blobId)
	if (existing) {
		existing.result = { content: output, status }
		await blob.write(sessionId, blobId, existing)
	}
	return { role: 'tool_result', tool_use_id: toolUseId, blobId, ts: new Date().toISOString() }
}

export async function writeUserEntry(sessionId: string, content: UserMessage['content']): Promise<UserMessage> {
	const entry: UserMessage = { role: 'user', content, ts: new Date().toISOString() }
	await appendHistory(sessionId, [entry])
	return entry
}

export async function appendHistory(sessionId: string, entries: Message[]): Promise<void> {
	if (entries.length === 0) return
	state.ensureDir(state.sessionDir(sessionId))
	await historyLog(sessionId).append(...entries)
}

export async function readHistory(sessionId: string): Promise<Message[]> {
	return historyLog(sessionId).readAll()
}

export const historyConfig = {
	maxApiOutput: 50_000,
}

export async function loadApiMessages(sessionId: string): Promise<any[]> {
	const all = await loadAllHistory(sessionId)
	const start = findReplayStart(all)
	const sliced = all.slice(start)
	const pruneOpts = prune.detectPruneOpts(sliced)
	const out: any[] = []
	for (const m of sliced) {
		const msg = m as any
		if (!msg.role) continue
		if (msg.role === 'user') {
			if (typeof msg.content === 'string') {
				out.push({ role: 'user', content: msg.content })
			} else if (Array.isArray(msg.content)) {
				const blocks: any[] = []
				for (const b of msg.content) {
					if (b.type === 'image' && b.blobId) {
						const data = await blob.read(sessionId, b.blobId)
						if (data?.media_type && data?.data) {
							blocks.push({ type: 'image', source: { type: 'base64', media_type: data.media_type, data: data.data }, _blobId: b.blobId })
						}
					} else {
						blocks.push(b)
					}
				}
				out.push({ role: 'user', content: blocks })
			}
		} else if (msg.role === 'assistant') {
			const content: any[] = []
			if (msg.thinkingText && msg.thinkingSignature)
				content.push({ type: 'thinking', thinking: msg.thinkingText, signature: msg.thinkingSignature })
			if (msg.text) content.push({ type: 'text', text: msg.text })
			if (msg.tools) {
				for (const t of msg.tools) {
					const blobData = await blob.read(sessionId, t.blobId)
					content.push({ type: 'tool_use', id: t.id, name: t.name, input: blobData?.call?.input ?? {} })
				}
			}
			if (content.length) out.push({ role: 'assistant', content })
		} else if (msg.role === 'tool_result') {
			const blobData = await blob.read(sessionId, msg.blobId)
			let content = blobData?.result?.content ?? '[interrupted]'
			const maxApiOutput = historyConfig.maxApiOutput
			if (typeof content === 'string' && content.length > maxApiOutput)
				content = content.slice(0, maxApiOutput) + `\n[truncated ${content.length - maxApiOutput} chars]`
			out.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: msg.tool_use_id, content, _blobId: msg.blobId }] })
		}
	}
	const resultIds = new Set<string>()
	for (const m of out) {
		if (m.role !== 'user' || !Array.isArray(m.content)) continue
		for (const b of m.content) {
			if (b.type === 'tool_result') resultIds.add(b.tool_use_id)
		}
	}
	for (let i = 0; i < out.length; i++) {
		if (out[i].role !== 'assistant' || !Array.isArray(out[i].content)) continue
		const missing = out[i].content.filter((b: any) => b.type === 'tool_use' && !resultIds.has(b.id))
		if (missing.length > 0) {
			const synthetic = {
				role: 'user',
				content: missing.map((b: any) => ({ type: 'tool_result', tool_use_id: b.id, content: '[interrupted]' })),
			}
			out.splice(i + 1, 0, synthetic)
			i++
		}
	}
	const pruned = prune.pruneApiMessages(out, pruneOpts)
	for (const msg of pruned) {
		if (msg.role === 'user' && Array.isArray(msg.content)) {
			for (const b of msg.content) {
				if (b._blobId) delete b._blobId
			}
		}
	}
	return pruned
}

export async function loadAllHistory(sessionId: string): Promise<Message[]> {
	return historyFork.loadAllHistory(sessionId, readHistory)
}

function findReplayStart(entries: Message[]): number {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i] as any
		if (e.type === 'reset' || e.type === 'compact') return i + 1
	}
	return 0
}

export function detectInterruptedTools(entries: Message[]): { name: string; id: string; blobId: string }[] {
	const completedToolIds = new Set<string>()
	for (const m of entries) {
		if ((m as any).role === 'tool_result') completedToolIds.add((m as any).tool_use_id)
	}
	for (let i = entries.length - 1; i >= 0; i--) {
		const m = entries[i] as any
		if (m.role === 'assistant' && m.tools) {
			const interrupted: { name: string; id: string; blobId: string }[] = []
			for (const t of m.tools) {
				if (!completedToolIds.has(t.id)) interrupted.push(t)
			}
			return interrupted
		}
	}
	return []
}

export function buildCompactionContext(sessionId: string, entries: Message[]): string {
	const userPrompts: string[] = []
	for (const entry of entries) {
		if ((entry as any).role !== 'user') continue
		const m = entry as any
		const text = typeof m.content === 'string' ? m.content : ''
		if (!text || text.startsWith('[')) continue
		userPrompts.push(text.split('\n')[0].slice(0, 200))
	}
	const dir = state.sessionDir(sessionId)
	if (userPrompts.length === 0) return `Context was compacted. No user prompts in previous conversation. Full history: ${dir}/history*.asonl + blobs/`
	const lines: string[] = [
		'Context was compacted to avoid exceeding the token limit. Verify before assuming.',
		'',
		'User messages from previous conversation:',
		'',
	]
	if (userPrompts.length <= 20) {
		userPrompts.forEach((p, i) => lines.push(`${i + 1}. ${p}`))
	} else {
		lines.push('First 10:')
		userPrompts.slice(0, 10).forEach((p, i) => lines.push(`${i + 1}. ${p}`))
		lines.push('')
		lines.push('Last 10:')
		const start = userPrompts.length - 10
		userPrompts.slice(-10).forEach((p, i) => lines.push(`${start + i + 1}. ${p}`))
	}
	lines.push('')
	lines.push(`Full history: ${dir}/history*.asonl + blobs/`)
	return lines.join('\n')
}

export async function loadInputHistory(sessionId: string): Promise<string[]> {
	const entries = await readHistory(sessionId)
	return entries
		.filter((e: any) => e.role === 'user')
		.map((e: any) => {
			if (typeof e.content === 'string') return e.content
			if (Array.isArray(e.content)) return e.content.find((b: any) => b.type === 'text')?.text ?? ''
			return ''
		})
		.filter((text: string) => text && !text.startsWith('['))
		.slice(-200)
}

export const history = {
	config: historyConfig,
	getLastUsage,
	writeUserEntry,
	writeAssistantEntry,
	writeToolResultEntry,
	appendHistory,
	readHistory,
	loadApiMessages,
	loadAllHistory,
	detectInterruptedTools,
	buildCompactionContext,
	loadInputHistory,
}
