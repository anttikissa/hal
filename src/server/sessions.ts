// Session persistence. Open sessions keep session.ason as a liveFile; closed
// sessions are read straight from disk until the runtime resumes them.

import { readFileSync, existsSync, readdirSync, rmSync, appendFileSync } from 'fs'
import type { SharedSessionInfo } from '../ipc.ts'
import { STATE_DIR, ensureDir } from '../state.ts'
import { ipc } from '../ipc.ts'
import { ason } from '../utils/ason.ts'
import { liveFiles } from '../utils/live-file.ts'
import { liveEventBlocks } from '../live-event-blocks.ts'
import type { PartialTokenUsage } from '../protocol.ts'

const SESSIONS_DIR = `${STATE_DIR}/sessions`
const DEFAULT_LOG = 'history.asonl'
const liveSessionMetas = new Map<string, SessionMeta>()
const liveSessionState = new Map<string, SessionLive>()

export interface SessionMeta {
	id: string
	workingDir?: string
	createdAt: string
	name?: string
	topic?: string
	model?: string
	currentLog?: string
	closedAt?: string
	forkedFrom?: string
	closeWhenDone?: boolean
	parentSessionId?: string
	// Last known context window usage, persisted so it survives restarts.
	context?: { used: number; max: number }
}

export type UserPart = { type: 'text'; text: string } | { type: 'image'; blobId: string; originalFile?: string }

export type HistoryEntry =
	| { type: 'user'; parts: UserPart[]; text?: never; source?: string; status?: string; ts?: string }
	| {
			type: 'thinking'
			text?: string
			blobId?: string
			signature?: string
			provider?: string
			model?: string
			thinkingEffort?: string
			ts?: string
	  }
	| {
			type: 'assistant'
			text: string
			model?: string
			id?: string
			continue?: string
			usage?: PartialTokenUsage
			ts?: string
	  }
	| { type: 'tool_call'; toolId: string; name: string; input?: any; blobId?: string; ts?: string }
	| { type: 'tool_result'; toolId: string; output?: any; blobId?: string; isError?: boolean; ts?: string }
	| { type: 'info'; text: string; level?: 'info' | 'warning' | 'error'; visibility?: 'ui' | 'next-user'; ts?: string }
	| { type: 'reset' | 'compact'; ts?: string }
	| { type: 'forked_from'; parent: string; ts?: string }
	| { type: 'input_history'; text: string; ts?: string }

export interface SessionLive {
	blocks: any[]
}

function sessionDir(sessionId: string): string { return `${SESSIONS_DIR}/${sessionId}` }
function sessionFile(sessionId: string, fileName: string): string { return `${sessionDir(sessionId)}/${fileName}` }
function ensureSessionDir(sessionId: string): void {
	ensureDir(sessionDir(sessionId))
}

function readAson<T>(path: string, fallback: T, parse: (text: string) => T): T {
	if (!existsSync(path)) return fallback
	try {
		return parse(readFileSync(path, 'utf-8'))
	} catch {
		return fallback
	}
}

function activateFile<T extends Record<string, any>>(
	cache: Map<string, T>,
	sessionId: string,
	fileName: string,
	defaults: T,
	fix: (data: T) => T,
	allowMissing = false,
): T | null {
	const cached = cache.get(sessionId)
	if (cached) return cached
	const path = sessionFile(sessionId, fileName)
	if (allowMissing && !existsSync(path)) return null
	ensureSessionDir(sessionId)
	const data = fix(liveFiles.liveFile(path, defaults, { watch: false }) as T)
	cache.set(sessionId, data)
	return data
}

function fixMeta(meta: SessionMeta, sessionId: string): SessionMeta {
	if (!meta.id) meta.id = sessionId
	if (!meta.currentLog) meta.currentLog = DEFAULT_LOG
	return meta
}

function defaultLive(): SessionLive { return { blocks: [] } }

function fixLive(live: SessionLive | null | undefined): SessionLive {
	const data = live ?? defaultLive()
	if (!Array.isArray(data.blocks)) data.blocks = []
	return data
}

function readLiveFromDisk(sessionId: string): SessionLive {
	return readAson(sessionFile(sessionId, 'live.ason'), defaultLive(), (text) =>
		fixLive(ason.parse(text) as unknown as SessionLive),
	)
}

function activateLive(sessionId: string): SessionLive {
	return activateFile(liveSessionState, sessionId, 'live.ason', defaultLive(), fixLive)!
}

function loadLive(sessionId: string): SessionLive {
	return liveSessionState.get(sessionId) ?? readLiveFromDisk(sessionId)
}

function saveLive(live: SessionLive): void {
	liveFiles.save(fixLive(live))
}

function updateLive(sessionId: string, mutator: (live: SessionLive) => void): SessionLive {
	const live = activateLive(sessionId)
	mutator(live)
	saveLive(live)
	return live
}

function applyLiveEvent(sessionId: string, event: any): void {
	updateLive(sessionId, (live) => {
		liveEventBlocks.applyEvent({ blocks: live.blocks, event, sessionId })
	})
}

function clearLive(sessionId: string): void {
	updateLive(sessionId, (live) => {
		live.blocks = []
	})
}

function readSessionMetaFromDisk(sessionId: string): SessionMeta | null {
	return readAson(sessionFile(sessionId, 'session.ason'), null, (text) =>
		fixMeta(ason.parse(text) as unknown as SessionMeta, sessionId),
	)
}

function activateSession(sessionId: string, defaults?: SessionMeta): SessionMeta | null {
	return activateFile(
		liveSessionMetas,
		sessionId,
		'session.ason',
		fixMeta({ id: sessionId, createdAt: defaults?.createdAt ?? new Date().toISOString(), ...defaults }, sessionId),
		(meta) => fixMeta(meta, sessionId),
		!defaults,
	)
}

function deactivateSession(sessionId: string): void {
	liveSessionMetas.delete(sessionId)
	liveSessionState.delete(sessionId)
}

function deactivateAllSessions(): void {
	liveSessionMetas.clear()
	liveSessionState.clear()
}

function loadSessionMeta(sessionId: string): SessionMeta | null {
	return liveSessionMetas.get(sessionId) ?? readSessionMetaFromDisk(sessionId)
}

function historyLogPath(sessionId: string, logName = loadSessionMeta(sessionId)?.currentLog ?? DEFAULT_LOG): string {
	return sessionFile(sessionId, logName)
}

function loadHistory(sessionId: string): HistoryEntry[] {
	const path = historyLogPath(sessionId)
	if (!existsSync(path)) return []
	try {
		const content = readFileSync(path, 'utf-8')
		return content.trim() ? (ason.parseAll(content) as HistoryEntry[]) : []
	} catch {
		return []
	}
}

function loadSessionList(): string[] {
	return [...ipc.readState().sessions]
}

function loadMetas(ids: string[], load: (id: string) => SessionMeta | null): SessionMeta[] {
	return ids.map(load).filter((meta): meta is SessionMeta => !!meta)
}

function loadSessionMetas(): SessionMeta[] { return loadMetas(loadSessionList(), activateSession) }
function loadAllSessionMetas(): SessionMeta[] {
	return existsSync(SESSIONS_DIR) ? loadMetas(readdirSync(SESSIONS_DIR).sort(), readSessionMetaFromDisk) : []
}

function loadAllHistory(sessionId: string): HistoryEntry[] {
	return loadAllHistoryWithOrigin(sessionId).entries
}

// Like loadAllHistory but also returns parent provenance for blob resolution.
function loadAllHistoryWithOrigin(sessionId: string): {
	entries: HistoryEntry[]
	parentCount: number
	parentId?: string
} {
	const entries = loadHistory(sessionId)
	const first = entries[0]
	if (first?.type !== 'forked_from' || !first.parent) return { entries, parentCount: 0 }
	const parent = loadAllHistoryWithOrigin(first.parent)
	const before = first.ts ? parent.entries.filter((entry) => !entry.ts || entry.ts < first.ts!) : parent.entries
	return { entries: [...before, ...entries.slice(1)], parentCount: before.length, parentId: first.parent }
}

function sessionOpenInfo(meta: Pick<SessionMeta, 'id' | 'name' | 'topic' | 'workingDir' | 'model'>): SharedSessionInfo {
	return { id: meta.id, name: meta.name ?? meta.topic, cwd: meta.workingDir ?? process.cwd(), model: meta.model }
}

function pickMostRecentlyClosedSessionId(
	metas: Array<{ id: string; createdAt: string; closedAt?: string }>,
	openIds: Set<string>,
): string | null {
	const closed = metas.filter((meta) => !openIds.has(meta.id)).sort((a, b) => (b.closedAt ?? b.createdAt).localeCompare(a.closedAt ?? a.createdAt))
	return closed[0]?.id ?? null
}

function normalizeSessionName(text: string): string { return text.trim().replace(/\s+/g, ' ').toLowerCase() }

function resolveResumeTarget(
	metas: Array<{ id: string; createdAt: string; closedAt?: string; name?: string; topic?: string }>,
	openIds: Set<string>,
	query?: string,
): string | null {
	const trimmed = query?.trim()
	if (!trimmed) return pickMostRecentlyClosedSessionId(metas, openIds)
	const exactId = metas.find((meta) => !openIds.has(meta.id) && meta.id === trimmed)
	if (exactId) return exactId.id
	const normalized = normalizeSessionName(trimmed)
	return metas.find((meta) => !openIds.has(meta.id) && normalizeSessionName(meta.name ?? meta.topic ?? '') === normalized)?.id ?? null
}

function saveMeta(meta: SessionMeta): void {
	liveFiles.save(fixMeta(meta, meta.id))
}

function createSession(id: string, meta: SessionMeta): SessionMeta {
	const liveMeta = activateSession(id, meta)
	if (!liveMeta) throw new Error(`Failed to create session ${id}`)
	Object.assign(liveMeta, meta)
	saveMeta(liveMeta)
	return liveMeta
}

function appendHistory(sessionId: string, entries: HistoryEntry[]): void {
	if (entries.length === 0) return
	ensureSessionDir(sessionId)
	appendFileSync(historyLogPath(sessionId), `${entries.map((entry) => ason.stringify(entry, 'short')).join('\n')}\n`)
}

function updateMeta(sessionId: string, updates: Partial<SessionMeta>): void {
	const meta = liveSessionMetas.get(sessionId)
	if (!meta) return
	Object.assign(meta, updates)
	saveMeta(meta)
}

function rotateLog(sessionId: string): string {
	const meta = liveSessionMetas.get(sessionId)
	if (!meta) throw new Error(`Session ${sessionId} is not live`)
	const currentLog = meta.currentLog ?? DEFAULT_LOG
	if (!existsSync(historyLogPath(sessionId, currentLog))) return currentLog
	const match = currentLog.match(/^history(\d+)\.asonl$/)
	const nextLog = `history${match ? parseInt(match[1]!, 10) + 1 : 2}.asonl`
	updateMeta(sessionId, { currentLog: nextLog })
	return nextLog
}

function rewriteHistoryAfterRotation(sessionId: string, entries: HistoryEntry[]): { oldLog: string; newLog: string } {
	const oldEntries = loadHistory(sessionId)
	const oldLog = loadSessionMeta(sessionId)?.currentLog ?? DEFAULT_LOG
	const newLog = rotateLog(sessionId)
	const forkEntry = oldEntries[0]?.type === 'forked_from' ? [oldEntries[0]] : []
	appendHistory(sessionId, [...forkEntry, ...entries])
	return { oldLog, newLog }
}


function forkSession(sourceId: string, newId: string, atIndex?: number): SessionMeta {
	const sourceMeta = loadSessionMeta(sourceId)
	if (!sourceMeta) throw new Error(`Source session ${sourceId} not found`)
	const history = atIndex !== undefined ? loadHistory(sourceId) : []
	const forkTs =
		atIndex !== undefined && atIndex >= 0 && atIndex < history.length && history[atIndex]!.ts
			? history[atIndex]!.ts!
			: new Date().toISOString()
	const child = createSession(newId, {
		id: newId,
		workingDir: sourceMeta.workingDir,
		createdAt: forkTs,
		topic: sourceMeta.topic ? `Fork of ${sourceMeta.topic}` : undefined,
		model: sourceMeta.model,
		forkedFrom: sourceId,
	})
	appendHistory(newId, [{ type: 'forked_from', parent: sourceId, ts: forkTs }])
	return child
}

function deleteSession(sessionId: string): void {
	deactivateSession(sessionId)
	if (existsSync(sessionDir(sessionId))) rmSync(sessionDir(sessionId), { recursive: true, force: true })
}

function detectInterruptedTools(entries: HistoryEntry[]): { name: string; id: string }[] {
	const completedToolIds = new Set<string>()
	for (const entry of entries) {
		if (entry.type === 'tool_result') completedToolIds.add(entry.toolId)
	}
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!
		if (entry.type !== 'tool_call') continue
		if (completedToolIds.has(entry.toolId)) return []
		const interrupted: { name: string; id: string }[] = []
		for (let j = i; j < entries.length; j++) {
			const next = entries[j]!
			if (next.type === 'tool_call') {
				if (!completedToolIds.has(next.toolId)) interrupted.push({ name: next.name, id: next.toolId })
				continue
			}
			if (next.type === 'tool_result') continue
			break
		}
		return interrupted
	}
	return []
}

export const sessions = {
	loadSessionMetas,
	loadAllSessionMetas,
	loadSessionList,
	loadSessionMeta,
	loadHistory,
	loadAllHistory,
	loadAllHistoryWithOrigin,
	loadLive,
	activateSession,
	deactivateSession,
	deactivateAllSessions,
	createSession,
	appendHistory,
	appendHistorySync: appendHistory,
	updateMeta,
	forkSession,
	deleteSession,
	rotateLog,
	rewriteHistoryAfterRotation,
	pickMostRecentlyClosedSessionId,
	resolveResumeTarget,
	sessionOpenInfo,
	detectInterruptedTools,
	applyLiveEvent,
	clearLive,
	sessionDir,
}
