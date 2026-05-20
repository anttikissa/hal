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

function statePath(sessionId: string): string {
	return `${sessionDir(sessionId)}/queue-state.ason`
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

function isHeld(sessionId: string): boolean {
	const path = statePath(sessionId)
	if (!existsSync(path)) return false
	try {
		const parsed = ason.parse(readFileSync(path, 'utf-8'))
		return !!(parsed && typeof parsed === 'object' && (parsed as Record<string, unknown>).held === true)
	} catch {
		return false
	}
}

function setHeld(sessionId: string, held: boolean): void {
	const path = statePath(sessionId)
	if (!held) {
		try {
			unlinkSync(path)
		} catch {}
		return
	}
	ensureDir(sessionDir(sessionId))
	writeFileSync(path, ason.stringify({ held: true }) + '\n')
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

function pop(sessionId: string): QueuedPrompt | undefined {
	const entries = load(sessionId)
	const first = entries[0]
	if (!first) return undefined
	const rest = entries.slice(1)
	if (rest.length > 0) save(sessionId, rest)
	else {
		try {
			unlinkSync(queuePath(sessionId))
		} catch {}
	}
	return first
}

function clear(sessionId: string): void {
	try {
		unlinkSync(queuePath(sessionId))
	} catch {}
	try {
		unlinkSync(statePath(sessionId))
	} catch {}
}

function drain(sessionId: string): QueuedPrompt[] {
	const entries = load(sessionId)
	if (entries.length > 0) clear(sessionId)
	return entries
}

export const promptQueue = { config, append, clear, drain, isHeld, load, pop, queuePath, setHeld, statePath }
