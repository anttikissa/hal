// Session persistence. Open sessions keep session.ason as a liveFile; closed
// sessions are read straight from disk until the runtime resumes them.

import { readFileSync, existsSync, readdirSync, mkdirSync, rmSync, appendFileSync } from 'fs'
import { appendFile } from 'fs/promises'
import { STATE_DIR } from '../state.ts'
import { ipc } from '../ipc.ts'
import { ason } from '../utils/ason.ts'
import { liveFiles } from '../utils/live-file.ts'

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
	lastPrompt?: string
	model?: string
	currentLog?: string
	closedAt?: string
	forkedFrom?: string
	closeWhenDone?: boolean
	parentSessionId?: string
	// Last known context window usage, persisted so it survives restarts
	context?: { used: number; max: number }
}

export type UserPart =
	| { type: 'text'; text: string }
	| { type: 'image'; blobId: string; originalFile?: string }

export type HistoryEntry =
	| {
			type: 'user'
			parts: UserPart[]
			text?: never
			source?: string
			status?: string
			ts?: string
	  }
	| {
			type: 'thinking'
			text?: string
			blobId?: string
			signature?: string
			provider?: string
			ts?: string
	  }
	| {
			type: 'assistant'
			text: string
			model?: string
			id?: string
			continue?: string
			usage?: { input: number; output: number }
			ts?: string
	  }
	| {
			type: 'tool_call'
			toolId: string
			name: string
			input?: any
			blobId?: string
			ts?: string
	  }
	| {
			type: 'tool_result'
			toolId: string
			output?: any
			blobId?: string
			isError?: boolean
			ts?: string
	  }
	| {
			type: 'info'
			text: string
			level?: 'info' | 'warning' | 'error'
			visibility?: 'ui' | 'next-user'
			ts?: string
	  }
	| {
			type: 'session'
			action: string
			model?: string
			old?: string
			new?: string
			ts?: string
	  }
	| {
			type: 'reset' | 'compact'
			ts?: string
	  }
	| {
			type: 'forked_from'
			parent: string
			ts?: string
	  }
	| {
			type: 'input_history'
			text: string
			ts?: string
	  }

export interface SessionLive {
	busy: boolean
	activity: string
	blocks: any[]
	updatedAt: string
}

function sessionDir(sessionId: string): string { return `${SESSIONS_DIR}/${sessionId}` }

function sessionLivePath(sessionId: string): string { return `${sessionDir(sessionId)}/live.ason` }

function sessionMetaPath(sessionId: string): string { return `${sessionDir(sessionId)}/session.ason` }

function ensureSessionDir(sessionId: string): void {
	if (!existsSync(sessionDir(sessionId))) mkdirSync(sessionDir(sessionId), { recursive: true })
}

function fixMeta(meta: SessionMeta, sessionId: string): SessionMeta {
	if (!meta.id) meta.id = sessionId
	if (!meta.currentLog) meta.currentLog = DEFAULT_LOG
	return meta
}

function defaultLive(): SessionLive {
	return {
		busy: false,
		activity: '',
		blocks: [],
		updatedAt: new Date().toISOString(),
	}
}

function fixLive(live: SessionLive | null | undefined): SessionLive {
	const data = live ?? defaultLive()
	if (typeof data.busy !== 'boolean') data.busy = false
	if (typeof data.activity !== 'string') data.activity = ''
	if (!Array.isArray(data.blocks)) data.blocks = []
	if (typeof data.updatedAt !== 'string') data.updatedAt = new Date().toISOString()
	return data
}

function readLiveFromDisk(sessionId: string): SessionLive {
	const path = sessionLivePath(sessionId)
	if (!existsSync(path)) return defaultLive()
	try {
		return fixLive(ason.parse(readFileSync(path, 'utf-8')) as unknown as SessionLive)
	} catch {
		return defaultLive()
	}
}

function activateLive(sessionId: string): SessionLive {
	const cached = liveSessionState.get(sessionId)
	if (cached) return cached
	ensureSessionDir(sessionId)
	const live = liveFiles.liveFile(sessionLivePath(sessionId), defaultLive(), { watch: false }) as SessionLive
	liveSessionState.set(sessionId, fixLive(live))
	return live
}

function loadLive(sessionId: string): SessionLive {
	return liveSessionState.get(sessionId) ?? readLiveFromDisk(sessionId)
}

function saveLive(live: SessionLive): void {
	live.updatedAt = new Date().toISOString()
	liveFiles.save(fixLive(live))
}

function updateLive(sessionId: string, mutator: (live: SessionLive) => void): SessionLive {
	const live = activateLive(sessionId)
	mutator(live)
	saveLive(live)
	return live
}

function lastLiveBlock(live: SessionLive): any | null {
	return live.blocks[live.blocks.length - 1] ?? null
}

function closeStreamingBlock(live: SessionLive): void {
	const last = lastLiveBlock(live)
	if (!last) return
	if ((last.type === 'assistant' || last.type === 'thinking') && last.streaming) delete last.streaming
}


function assistantChainId(block: any): string | null {
	if (block?.type !== 'assistant') return null
	return block.continue ?? block.id ?? null
}

function lastInterruptedAssistantId(live: SessionLive): string | null {
	for (let i = live.blocks.length - 1; i >= 0; i--) {
		const block = live.blocks[i]
		if (!block) continue
		if (block.type === 'tool') continue
		if (block.type === 'info' || block.type === 'warning' || block.type === 'error') continue
		return block.type === 'assistant' ? assistantChainId(block) : null
	}
	return null
}

function applyLiveEvent(sessionId: string, event: any): void {
	if (!event?.type) return
	updateLive(sessionId, (live) => {
		const ts = event.createdAt ? Date.parse(event.createdAt) : undefined
		if (event.type === 'stream-start') {
			closeStreamingBlock(live)
			return
		}
		if (event.type === 'stream-delta' && event.text) {
			const last = lastLiveBlock(live)
			if (event.channel === 'thinking') {
				if (last?.type === 'thinking' && last.streaming) {
					last.text += event.text
					if (event.blobId) last.blobId = event.blobId
					if (!last.sessionId) last.sessionId = sessionId
					if (!last.ts) last.ts = ts
					return
				}
				closeStreamingBlock(live)
				live.blocks.push({ type: 'thinking', text: event.text, blobId: event.blobId, sessionId, ts, streaming: true })
				return
			}
			if (last?.type === 'assistant' && last.streaming) {
				last.text += event.text
				if (!last.ts) last.ts = ts
				return
			}
			closeStreamingBlock(live)
			const continueId = lastInterruptedAssistantId(live)
			live.blocks.push({
				type: 'assistant',
				text: event.text,
				id: continueId ? undefined : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
				continue: continueId ?? undefined,
				ts,
				streaming: true,
			})
			return
		}
		if (event.type === 'tool-call') {
			closeStreamingBlock(live)
			live.blocks.push({
				type: 'tool',
				name: event.name,
				input: event.input,
				blobId: event.blobId,
				sessionId,
				toolId: event.toolId,
				ts,
			})
			return
		}
		if (event.type === 'tool-result') {
			const toolBlock = live.blocks.findLast((block: any) => block?.type === 'tool' && block.toolId === event.toolId)
			if (toolBlock) {
				toolBlock.output = event.output
				if (event.blobId) toolBlock.blobId = event.blobId
			}
			return
		}
		if (event.type === 'info' && event.text) {
			closeStreamingBlock(live)
			live.blocks.push({ type: event.level === 'error' ? 'error' : 'info', text: event.text, ts })
			return
		}
		if (event.type === 'response' && event.isError && event.text) {
			closeStreamingBlock(live)
			live.blocks.push({ type: 'error', text: event.text, blobId: event.blobId, sessionId, ts })
			return
		}
		if (event.type === 'stream-end') closeStreamingBlock(live)
	})
}

function clearLive(sessionId: string): void {
	updateLive(sessionId, (live) => {
		live.blocks = []
	})
}

function readSessionMetaFromDisk(sessionId: string): SessionMeta | null {
	const path = sessionMetaPath(sessionId)
	if (!existsSync(path)) return null
	try {
		return fixMeta(ason.parse(readFileSync(path, 'utf-8')) as unknown as SessionMeta, sessionId)
	} catch {
		return null
	}
}

function activateSession(sessionId: string, defaults?: SessionMeta): SessionMeta | null {
	const cached = liveSessionMetas.get(sessionId)
	if (cached) return cached
	const path = sessionMetaPath(sessionId)
	if (!defaults && !existsSync(path)) return null
	ensureSessionDir(sessionId)
	const meta = liveFiles.liveFile(
		path,
		fixMeta({ id: sessionId, createdAt: defaults?.createdAt ?? new Date().toISOString(), ...defaults }, sessionId),
		{ watch: false },
	) as SessionMeta
	liveSessionMetas.set(sessionId, fixMeta(meta, sessionId))
	return meta
}

function deactivateSession(sessionId: string): void {
	liveSessionMetas.delete(sessionId)
	liveSessionState.delete(sessionId)
}

function deactivateAllSessions(): void {
	liveSessionMetas.clear()
	liveSessionState.clear()
}

function loadSessionMeta(sessionId: string): SessionMeta | null { return liveSessionMetas.get(sessionId) ?? readSessionMetaFromDisk(sessionId) }

function historyLogPath(sessionId: string, logName = loadSessionMeta(sessionId)?.currentLog ?? DEFAULT_LOG): string {
	return `${sessionDir(sessionId)}/${logName}`
}

function loadHistory(sessionId: string): HistoryEntry[] {
	const path = historyLogPath(sessionId)
	if (!existsSync(path)) return []
	try {
		const content = readFileSync(path, 'utf-8')
		return content.trim() ? (ason.parseAll(content) as unknown as HistoryEntry[]) : []
	} catch {
		return []
	}
}

function loadSessionList(): string[] {
	return [...ipc.readState().sessions]
}

function collectMetas(ids: string[], load: (id: string) => SessionMeta | null): SessionMeta[] {
	const metas: SessionMeta[] = []
	for (const id of ids) {
		const meta = load(id)
		if (meta) metas.push(meta)
	}
	return metas
}

function loadSessionMetas(): SessionMeta[] {
	return collectMetas(loadSessionList(), activateSession)
}

function loadAllSessionMetas(): SessionMeta[] {
	return existsSync(SESSIONS_DIR) ? collectMetas(readdirSync(SESSIONS_DIR).sort(), readSessionMetaFromDisk) : []
}

function loadAllHistory(sessionId: string): HistoryEntry[] {
	return loadAllHistoryWithOrigin(sessionId).entries
}

// Like loadAllHistory but also returns how many entries came from the parent
// and the parent's session ID (needed so blob paths resolve correctly).
function loadAllHistoryWithOrigin(sessionId: string): { entries: HistoryEntry[]; parentCount: number; parentId?: string } {
	const entries = loadHistory(sessionId)
	const first = entries[0]
	if (first?.type !== 'forked_from' || !first.parent) return { entries, parentCount: 0 }
	const parent = loadAllHistoryWithOrigin(first.parent)
	const forkTs = first.ts
	const before = forkTs ? parent.entries.filter((e) => !e.ts || e.ts < forkTs) : parent.entries
	return { entries: [...before, ...entries.slice(1)], parentCount: before.length, parentId: first.parent }
}

function saveMeta(meta: SessionMeta): void { liveFiles.save(fixMeta(meta, meta.id)) }

async function createSession(id: string, meta: SessionMeta): Promise<void> {
	const liveMeta = activateSession(id, meta)
	if (liveMeta) { Object.assign(liveMeta, meta); saveMeta(liveMeta) }
}

function historyLines(entries: HistoryEntry[]): string {
	return entries.map((e) => ason.stringify(e, 'short')).join('\n') + '\n'
}

async function appendHistory(sessionId: string, entries: HistoryEntry[]): Promise<void> {
	if (entries.length === 0) return
	ensureSessionDir(sessionId)
	await appendFile(historyLogPath(sessionId), historyLines(entries))
}

function appendHistorySync(sessionId: string, entries: HistoryEntry[]): void {
	if (entries.length === 0) return
	ensureSessionDir(sessionId)
	appendFileSync(historyLogPath(sessionId), historyLines(entries))
}

async function updateMeta(sessionId: string, updates: Partial<SessionMeta>): Promise<void> {
	const meta = liveSessionMetas.get(sessionId)
	if (meta) { Object.assign(meta, updates); saveMeta(meta) }
}

async function rotateLog(sessionId: string): Promise<string> {
	const meta = liveSessionMetas.get(sessionId)
	if (!meta) throw new Error(`Session ${sessionId} is not live`)
	const currentLog = meta.currentLog ?? DEFAULT_LOG
	if (!existsSync(historyLogPath(sessionId, currentLog))) return currentLog
	const match = currentLog.match(/^history(\d+)\.asonl$/)
	const nextLog = `history${match ? parseInt(match[1]!, 10) + 1 : 2}.asonl`
	await updateMeta(sessionId, { currentLog: nextLog })
	return nextLog
}

async function forkSession(sourceId: string, newId: string, atIndex?: number): Promise<void> {
	const sourceMeta = loadSessionMeta(sourceId)
	if (!sourceMeta) throw new Error(`Source session ${sourceId} not found`)
	const history = atIndex !== undefined ? loadHistory(sourceId) : []
	const forkTs = atIndex !== undefined && atIndex >= 0 && atIndex < history.length && history[atIndex]!.ts
		? history[atIndex]!.ts!
		: new Date().toISOString()
	await createSession(newId, {
		id: newId,
		workingDir: sourceMeta.workingDir,
		createdAt: forkTs,
		topic: sourceMeta.topic ? `Fork of ${sourceMeta.topic}` : undefined,
		model: sourceMeta.model,
		forkedFrom: sourceId,
	})
	await appendHistory(newId, [{ type: 'forked_from', parent: sourceId, ts: forkTs }])
}

function deleteSession(sessionId: string): void {
	deactivateSession(sessionId)
	if (existsSync(sessionDir(sessionId))) rmSync(sessionDir(sessionId), { recursive: true, force: true })
}

const pruneConfig = {
	// Delete sessions older than this many days
	maxAgeDays: 90,
	// Keep at most this many sessions
	maxCount: 200,
}

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
			deleted++
			continue
		}
		if (now - new Date(meta.createdAt).getTime() > maxAge) {
			deleteSession(id)
			deleted++
		} else {
			keep.push(id)
		}
	}
	if (keep.length > pruneConfig.maxCount) {
		for (const id of keep.splice(0, keep.length - pruneConfig.maxCount)) {
			deleteSession(id)
			deleted++
		}
	}
	if (deleted > 0) ipc.updateState((state) => { state.sessions = keep })
	return { deleted }
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
	appendHistorySync,
	updateMeta,
	forkSession,
	deleteSession,
	rotateLog,
	pruneSessions,
	pruneConfig,
	detectInterruptedTools,
	applyLiveEvent,
	clearLive,
	sessionDir,
}
