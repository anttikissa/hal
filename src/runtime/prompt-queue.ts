import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { STATE_DIR, ensureDir } from '../state.ts'
import { ason } from '../utils/ason.ts'

export interface QueuedPrompt {
	text: string
	source?: string
	displayText?: string
	createdAt: string
}

const config = {
	sessionsDir: `${STATE_DIR}/sessions`,
}

function sessionDir(sessionId: string): string {
	return `${promptQueue.config.sessionsDir}/${sessionId}`
}

function queuePath(sessionId: string): string {
	return `${sessionDir(sessionId)}/queue.ason`
}

function clean(entry: QueuedPrompt): QueuedPrompt {
	const out: QueuedPrompt = { text: entry.text, createdAt: entry.createdAt }
	if (entry.source !== undefined) out.source = entry.source
	if (entry.displayText !== undefined) out.displayText = entry.displayText
	return out
}

function load(sessionId: string): QueuedPrompt[] {
	const path = queuePath(sessionId)
	if (!existsSync(path)) return []
	try {
		const parsed = ason.parse(readFileSync(path, 'utf-8'))
		if (!Array.isArray(parsed)) return []
		const entries: QueuedPrompt[] = []
		for (const item of parsed) {
			if (!item || typeof item !== 'object') continue
			const raw = item as Record<string, unknown>
			if (typeof raw.text !== 'string' || typeof raw.createdAt !== 'string') continue
			entries.push(clean({
				text: raw.text,
				createdAt: raw.createdAt,
				source: typeof raw.source === 'string' ? raw.source : undefined,
				displayText: typeof raw.displayText === 'string' ? raw.displayText : undefined,
			}))
		}
		return entries
	} catch {
		return []
	}
}

function save(sessionId: string, entries: QueuedPrompt[]): void {
	ensureDir(sessionDir(sessionId))
	writeFileSync(queuePath(sessionId), ason.stringify(entries) + '\n')
}

function append(sessionId: string, entry: QueuedPrompt): number {
	const entries = load(sessionId)
	entries.push(clean(entry))
	save(sessionId, entries)
	return entries.length
}

function clear(sessionId: string): void {
	try {
		unlinkSync(queuePath(sessionId))
	} catch {}
}

function drain(sessionId: string): QueuedPrompt[] {
	const entries = load(sessionId)
	if (entries.length > 0) clear(sessionId)
	return entries
}

export const promptQueue = { config, append, clear, drain, load, queuePath }
