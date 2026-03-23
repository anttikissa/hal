// Session persistence -- load/save session metadata and history.

import { readFileSync, existsSync, readdirSync } from 'fs'
import { STATE_DIR } from '../state.ts'
import { ason } from '../utils/ason.ts'
import { perf } from '../perf.ts'

const SESSIONS_DIR = `${STATE_DIR}/sessions`

export interface SessionMeta {
	id: string
	workingDir?: string
	createdAt: string
	topic?: string
	lastPrompt?: string
}

export interface HistoryEntry {
	// User/assistant messages
	role?: 'user' | 'assistant' | 'tool_result'
	// Info/session entries
	type?: 'info' | 'session'
	text?: string
	content?: string
	ts?: string
	// We preserve all other fields but don't need to type them
	[key: string]: any
}

// Load session metadata from session.ason
function loadSessionMeta(sessionId: string): SessionMeta | null {
	const path = `${SESSIONS_DIR}/${sessionId}/session.ason`
	if (!existsSync(path)) return null
	try {
		return ason.parse(readFileSync(path, 'utf-8')) as unknown as SessionMeta
	} catch {
		return null
	}
}

// Load history entries from history.asonl
function loadHistory(sessionId: string): HistoryEntry[] {
	const path = `${SESSIONS_DIR}/${sessionId}/history.asonl`
	if (!existsSync(path)) return []
	try {
		const content = readFileSync(path, 'utf-8')
		if (!content.trim()) return []
		return ason.parseAll(content) as unknown as HistoryEntry[]
	} catch {
		return []
	}
}

// Get the display text for a history entry.
// User messages can have content as a string or an array of content blocks
// (multimodal: text + images). Extract text parts, skip images.
function entryText(entry: HistoryEntry): string | null {
	if (entry.role === 'user') {
		const content = entry.content ?? entry.text
		if (typeof content === 'string') return content
		if (Array.isArray(content)) {
			// Multimodal: extract text blocks, show placeholder for images.
			const parts: string[] = []
			for (const part of content as any[]) {
				if (part?.type === 'text' && typeof part.text === 'string') parts.push(part.text)
				else if (part?.type === 'image') parts.push('[image]')
			}
			return parts.join('') || null
		}
		return null
	}
	if (entry.role === 'assistant') return typeof entry.text === 'string' ? entry.text : null
	if (entry.type === 'info') return typeof entry.text === 'string' ? entry.text : null
	return null
}

// Map history entry to our Entry type for display.
function entryType(entry: HistoryEntry): 'input' | 'assistant' | 'info' | null {
	if (entry.role === 'user') return 'input'
	if (entry.role === 'assistant') return 'assistant'
	if (entry.type === 'info') return 'info'
	return null
}

// Load a session list (ordered array of session IDs) from IPC state.
function loadSessionList(): string[] {
	const path = `${STATE_DIR}/ipc/state.ason`
	if (!existsSync(path)) return []
	try {
		const state = ason.parse(readFileSync(path, 'utf-8')) as any
		return state?.sessions ?? []
	} catch {
		return []
	}
}

export interface LoadedSession {
	meta: SessionMeta
	entries: { type: 'input' | 'assistant' | 'info'; text: string; ts?: number }[]
}

// Load all sessions. Returns them in tab order.
function loadAllSessions(): LoadedSession[] {
	perf.mark('Loading sessions')
	const ids = loadSessionList()
	if (ids.length === 0) return []

	const result: LoadedSession[] = []
	for (const id of ids) {
		const meta = loadSessionMeta(id)
		if (!meta) continue

		const history = loadHistory(id)
		const entries: LoadedSession['entries'] = []
		for (const h of history) {
			const type = entryType(h)
			const text = entryText(h)
			if (type && text) {
				entries.push({
					type,
					text,
					ts: h.ts ? Date.parse(h.ts) : undefined,
				})
			}
		}
		result.push({ meta, entries })
	}
	perf.mark(`Loaded ${result.length} sessions (${ids.length} listed)`)
	return result
}

export const sessions = { loadAllSessions, loadSessionList, loadSessionMeta, loadHistory }
