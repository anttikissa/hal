// Conversation log — append-only ASONL per session.

import { writeFile, readFile, unlink } from 'fs/promises'
import { existsSync } from 'fs'
import { Log } from '../utils/log.ts'
import { sessionDir, ensureDir } from '../state.ts'

function messagesLog(sessionId: string) {
	return new Log<Message>(`${sessionDir(sessionId)}/messages.asonl`)
}

// ── Message types ──

export interface UserMessage {
	role: 'user'
	content: string
	ts: string
}

export interface AssistantMessage {
	role: 'assistant'
	text?: string
	thinkingText?: string
	tools?: { id: string; name: string; input: unknown; result?: string }[]
	ts: string
}

export interface ToolResultMessage {
	role: 'tool_result'
	tool_use_id: string
	content: string
	ts: string
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage
	| { type: 'reset'; ts: string }
	| { type: 'forked_from'; parent: string; ts: string }

// ── I/O ──

export async function appendMessages(sessionId: string, entries: Message[]): Promise<void> {
	if (entries.length === 0) return
	ensureDir(sessionDir(sessionId))
	await messagesLog(sessionId).append(...entries)
}

export async function readMessages(sessionId: string): Promise<Message[]> {
	return messagesLog(sessionId).readAll()
}

/** Load messages for API replay: converts stored format → Anthropic API format. */
export async function loadApiMessages(sessionId: string): Promise<any[]> {
	const all = await loadAllMessages(sessionId)
	const start = findReplayStart(all)
	const out: any[] = []
	for (const m of all.slice(start)) {
		const msg = m as any
		if (!msg.role) continue
		if (msg.role === 'user') {
			out.push({ role: 'user', content: msg.content })
		} else if (msg.role === 'assistant') {
			const content: any[] = []
			if (msg.thinkingText) content.push({ type: 'thinking', thinking: msg.thinkingText })
			if (msg.text) content.push({ type: 'text', text: msg.text })
			if (msg.tools) {
				for (const t of msg.tools) {
					content.push({ type: 'tool_use', id: t.id, name: t.name, input: t.input })
				}
			}
			if (content.length) out.push({ role: 'assistant', content })
			// Emit tool results as separate user messages
			if (msg.tools) {
				for (const t of msg.tools) {
					if (t.result !== undefined) {
						out.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: t.id, content: t.result }] })
					}
				}
			}
		}
	}
	return out
}

/** Follow fork chain to load full history. */
async function loadAllMessages(sessionId: string): Promise<Message[]> {
	const entries = await readMessages(sessionId)
	if (entries.length > 0 && (entries[0] as any).type === 'forked_from') {
		const parent = (entries[0] as any).parent
		const forkTs = (entries[0] as any).ts
		const parentEntries = await loadAllMessages(parent)
		const before = parentEntries.filter((e: any) => !e.ts || e.ts <= forkTs)
		return [...before, ...entries.slice(1)]
	}
	return entries
}

function findReplayStart(entries: Message[]): number {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i] as any
		if (e.type === 'reset' || e.type === 'handoff') return i + 1
	}
	return 0
}

/** Extract user input texts for prompt history. */
export async function loadInputHistory(sessionId: string): Promise<string[]> {
	const entries = await readMessages(sessionId)
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

// ── Draft persistence ──

function draftPath(sessionId: string): string {
	return `${sessionDir(sessionId)}/draft.txt`
}

export async function saveDraft(sessionId: string, text: string): Promise<void> {
	if (!text) {
		const p = draftPath(sessionId)
		if (existsSync(p)) await unlink(p).catch(() => {})
		return
	}
	ensureDir(sessionDir(sessionId))
	await writeFile(draftPath(sessionId), text)
}

export async function loadDraft(sessionId: string): Promise<string> {
	const p = draftPath(sessionId)
	if (!existsSync(p)) return ''
	try { return await readFile(p, 'utf-8') } catch { return '' }
}