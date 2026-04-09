// Session persistence — load/save session metadata and history.
//
// Read operations are synchronous (used at startup). Write operations are async
// because they go through fs.writeFile / fs.appendFile. Pruning deletes old
// sessions on startup to keep disk usage bounded.

import { readFileSync, existsSync, readdirSync, mkdirSync, rmSync, appendFileSync } from 'fs'
import { writeFile, appendFile } from 'fs/promises'
import { STATE_DIR } from '../state.ts'
import { ipc } from '../ipc.ts'
import { ason } from '../utils/ason.ts'
import { perf } from '../perf.ts'

const SESSIONS_DIR = `${STATE_DIR}/sessions`

export interface SessionMeta {
	id: string
	workingDir?: string
	createdAt: string
	topic?: string
	lastPrompt?: string
	model?: string
	currentLog?: string
	closedAt?: string
	// Last known context window usage, persisted so it survives restarts
	context?: { used: number; max: number }
}

export interface HistoryEntry {
	// User/assistant messages
	role?: 'user' | 'assistant' | 'tool_result'
	// Info/session/reset/compact/forked_from entries
	type?: 'info' | 'session' | 'reset' | 'compact' | 'forked_from'
	text?: string
	content?: string | any[]
	ts?: string
	// We preserve all other fields but don't need to type them
	[key: string]: any
}

// ── Helpers ──

function sessionDir(sessionId: string): string {
	return `${SESSIONS_DIR}/${sessionId}`
}

function ensureSessionDir(sessionId: string): void {
	const dir = sessionDir(sessionId)
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function historyLogName(sessionId: string): string {
	return loadSessionMeta(sessionId)?.currentLog ?? 'history.asonl'
}

function historyLogPath(sessionId: string, logName?: string): string {
	return `${sessionDir(sessionId)}/${logName ?? historyLogName(sessionId)}`
}

// ── Read operations ──

// Load session metadata from session.ason
function loadSessionMeta(sessionId: string): SessionMeta | null {
	const path = `${sessionDir(sessionId)}/session.ason`
	if (!existsSync(path)) return null
	try {
		return ason.parse(readFileSync(path, 'utf-8')) as unknown as SessionMeta
	} catch {
		return null
	}
}

// Load history entries from the session's current history log.
function loadHistory(sessionId: string): HistoryEntry[] {
	const path = historyLogPath(sessionId)
	if (!existsSync(path)) return []
	try {
		const content = readFileSync(path, 'utf-8')
		if (!content.trim()) return []
		return ason.parseAll(content) as unknown as HistoryEntry[]
	} catch {
		return []
	}
}

// Load a session list (ordered array of session IDs) from shared IPC state.
function loadSessionList(): string[] {
	return [...ipc.readState().sessions]
}

export interface LoadedSession {
	meta: SessionMeta
	history: HistoryEntry[]
}

// Load all sessions. Returns them in tab order.
// History entries are returned raw — the client uses blocks.historyToBlocks()
// to split them into renderable blocks.
function loadAllSessions(): LoadedSession[] {
	perf.mark('Loading sessions')
	const ids = loadSessionList()
	if (ids.length === 0) return []

	const result: LoadedSession[] = []
	for (const id of ids) {
		const meta = loadSessionMeta(id)
		if (!meta) continue
		result.push({ meta, history: loadHistory(id) })
	}
	perf.mark(`Loaded ${result.length} sessions (${ids.length} listed)`)
	return result
}

// Load just session metadata (no history). Fast — only reads session.ason files.
function loadSessionMetas(): SessionMeta[] {
	const ids = loadSessionList()
	const result: SessionMeta[] = []
	for (const id of ids) {
		const meta = loadSessionMeta(id)
		if (meta) result.push(meta)
	}
	return result
}

// Load metadata for every session directory on disk, including closed sessions.
function loadAllSessionMetas(): SessionMeta[] {
	if (!existsSync(SESSIONS_DIR)) return []
	const result: SessionMeta[] = []
	for (const id of readdirSync(SESSIONS_DIR).sort()) {
		const meta = loadSessionMeta(id)
		if (meta) result.push(meta)
	}
	return result
}

// Load full history including forked parent chains. Follows forked_from entries
// to reconstruct the complete conversation history.
function loadAllHistory(sessionId: string): HistoryEntry[] {
	const entries = loadHistory(sessionId)
	if (entries.length === 0) return entries

	// If this session was forked, prepend parent history up to the fork point
	const first = entries[0]
	if (first?.type === 'forked_from' && first.parent) {
		const parentEntries = loadAllHistory(first.parent)
		const forkTs = first.ts
		// Keep parent entries before the fork timestamp
		const before = forkTs ? parentEntries.filter((e) => !e.ts || e.ts < forkTs) : parentEntries
		return [...before, ...entries.slice(1)]
	}
	return entries
}

// ── Write operations ──

// Create a new session with initial metadata.
async function createSession(id: string, meta: SessionMeta): Promise<void> {
	ensureSessionDir(id)
	const path = `${sessionDir(id)}/session.ason`
	await writeFile(path, ason.stringify({ ...meta, currentLog: meta.currentLog ?? 'history.asonl' }) + '\n')
}

// Append one or more history entries to the session's current history log.
// Each entry is serialized as a single-line ASON value (short mode).
async function appendHistory(sessionId: string, entries: HistoryEntry[]): Promise<void> {
	if (entries.length === 0) return
	ensureSessionDir(sessionId)
	const path = historyLogPath(sessionId)
	const lines = entries.map((e) => ason.stringify(e, 'short')).join('\n') + '\n'
	await appendFile(path, lines)
}

// Synchronous version of appendHistory for cases where we can't await
// (e.g. signal handlers). Use sparingly.
function appendHistorySync(sessionId: string, entries: HistoryEntry[]): void {
	if (entries.length === 0) return
	ensureSessionDir(sessionId)
	const path = historyLogPath(sessionId)
	const lines = entries.map((e) => ason.stringify(e, 'short')).join('\n') + '\n'
	appendFileSync(path, lines)
}

// Update session metadata. Reads existing meta, merges updates, writes back.
async function updateMeta(sessionId: string, updates: Partial<SessionMeta>): Promise<void> {
	const existing = loadSessionMeta(sessionId)
	if (!existing) return
	const merged = { ...existing, ...updates }
	const path = `${sessionDir(sessionId)}/session.ason`
	await writeFile(path, ason.stringify(merged) + '\n')
}

// Rotate to a fresh history log. Old logs stay on disk for manual inspection.
async function rotateLog(sessionId: string): Promise<string> {
	const meta = loadSessionMeta(sessionId)
	if (!meta) throw new Error(`Session ${sessionId} not found`)

	const currentLog = meta.currentLog ?? 'history.asonl'
	const currentPath = historyLogPath(sessionId, currentLog)
	if (!existsSync(currentPath)) return currentLog

	let nextN = 2
	if (currentLog !== 'history.asonl') {
		const match = currentLog.match(/^history(\d+)\.asonl$/)
		if (match) nextN = parseInt(match[1]!, 10) + 1
	}

	const nextLog = `history${nextN}.asonl`
	await updateMeta(sessionId, { currentLog: nextLog })
	return nextLog
}

// Fork a session: create a new session whose history starts with a forked_from
// marker, then optionally copy entries up to atIndex from the source.
// The parent's history is not copied — loadAllHistory follows the fork chain.
async function forkSession(sourceId: string, newId: string, atIndex?: number): Promise<void> {
	const sourceMeta = loadSessionMeta(sourceId)
	if (!sourceMeta) throw new Error(`Source session ${sourceId} not found`)

	// Determine fork timestamp: use the atIndex-th entry's ts, or now
	let forkTs = new Date().toISOString()
	if (atIndex !== undefined) {
		const history = loadHistory(sourceId)
		if (atIndex >= 0 && atIndex < history.length && history[atIndex]!.ts) {
			forkTs = history[atIndex]!.ts!
		}
	}

	// Create the new session with a forked_from marker as first entry
	const newMeta: SessionMeta = {
		id: newId,
		workingDir: sourceMeta.workingDir,
		createdAt: forkTs,
		topic: sourceMeta.topic ? `Fork of ${sourceMeta.topic}` : undefined,
		model: sourceMeta.model,
	}
	await createSession(newId, newMeta)
	await appendHistory(newId, [{ type: 'forked_from', parent: sourceId, ts: forkTs }])
}

// Delete a session directory and all its contents.
function deleteSession(sessionId: string): void {
	const dir = sessionDir(sessionId)
	if (existsSync(dir)) {
		rmSync(dir, { recursive: true, force: true })
	}
}



// ── Pruning ──

const pruneConfig = {
	// Delete sessions older than this many days
	maxAgeDays: 90,
	// Keep at most this many sessions
	maxCount: 200,
}

// Prune old sessions on startup. Deletes sessions older than maxAgeDays
// and trims the list to maxCount (keeping newest). Runs synchronously
// since it's called once during startup.
function pruneSessions(): { deleted: number } {
	const ids = loadSessionList()
	if (ids.length === 0) return { deleted: 0 }

	const now = Date.now()
	const maxAge = pruneConfig.maxAgeDays * 24 * 60 * 60 * 1000
	const keep: string[] = []
	let deleted = 0

	for (const id of ids) {
		const meta = loadSessionMeta(id)
		if (!meta) {
			// Session dir missing — drop from list
			deleted++
			continue
		}
		const age = now - new Date(meta.createdAt).getTime()
		if (age > maxAge) {
			deleteSession(id)
			deleted++
		} else {
			keep.push(id)
		}
	}

	// Trim to maxCount, removing oldest (earliest in list) first
	if (keep.length > pruneConfig.maxCount) {
		const excess = keep.splice(0, keep.length - pruneConfig.maxCount)
		for (const id of excess) {
			deleteSession(id)
			deleted++
		}
	}

	// Update session list in shared state if anything changed.
	if (deleted > 0) {
		ipc.updateState((state) => {
			state.sessions = keep
		})
	}

	return { deleted }
}

// ── Interrupted tool detection ──

// Find tool calls in the last assistant message that lack matching tool_result entries.
// Used to show "[interrupted] during tools" hint on session resume.
function detectInterruptedTools(entries: HistoryEntry[]): { name: string; id: string }[] {
	const completedToolIds = new Set<string>()
	for (const m of entries) {
		if (m.role === 'tool_result' && m.tool_use_id) completedToolIds.add(m.tool_use_id)
	}
	// Walk backwards to find the last assistant message with tools
	for (let i = entries.length - 1; i >= 0; i--) {
		const m = entries[i]!
		if (m.role === 'assistant' && Array.isArray(m.tools)) {
			const interrupted: { name: string; id: string }[] = []
			for (const t of m.tools) {
				if (!completedToolIds.has(t.id)) {
					interrupted.push({ name: t.name, id: t.id })
				}
			}
			return interrupted
		}
	}
	return []
}

export const sessions = {
	// Read
	loadAllSessions,
	loadSessionMetas,
	loadAllSessionMetas,
	loadSessionList,
	loadSessionMeta,
	loadHistory,
	loadAllHistory,
	// Write
	createSession,
	appendHistory,
	appendHistorySync,
	updateMeta,
	forkSession,
	deleteSession,
	rotateLog,
	// Pruning
	pruneSessions,
	pruneConfig,
	// Utilities
	detectInterruptedTools,
	sessionDir,
}
