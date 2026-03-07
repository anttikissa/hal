// Conversation log — append-only ASONL per session.

import { asonlLog } from '../utils/asonl-log.ts'
import { sessionDir, ensureDir } from '../state.ts'

function messagesLog(sessionId: string) {
	return asonlLog<Message>(`${sessionDir(sessionId)}/messages.asonl`)
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

/** Load messages for API replay: skip before last reset/handoff, follow fork chain. */
export async function loadApiMessages(sessionId: string): Promise<Message[]> {
	const all = await loadAllMessages(sessionId)
	const start = findReplayStart(all)
	return all.slice(start)
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
