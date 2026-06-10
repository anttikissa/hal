// Rebase command handling — snapshot lifecycle for interactive /rebase.
//
// A rebase-start command snapshots history; the client edits a todo file;
// rebase-apply validates the snapshot is still current and rewrites history.

import { createHash } from 'crypto'
import { ipc } from '../ipc.ts'
import { sessions as sessionStore, type HistoryEntry } from './sessions.ts'
import { agentLoop } from '../runtime/agent-loop.ts'
import { apiMessages } from '../session/api-messages.ts'
import { rebase, type RebaseSnapshot } from '../session/rebase.ts'
import { openai } from '../providers/openai.ts'
// Circular import with runtime.ts is safe: we only access runtime.* at call time
// (module convention — all cross-module calls go through namespace objects).
import { runtime } from './runtime.ts'

const snapshots = new Map<string, { sessionId: string; clientPid: number; baseLog: string; baseHash: string; snapshot: RebaseSnapshot }>()

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err)
}

function historyHash(entries: HistoryEntry[]): string {
	const text = entries.map((entry) => JSON.stringify(entry)).join('\n')
	return createHash('sha256').update(text).digest('hex')
}

function emitRebaseResult(clientPid: number, requestId: string, sessionId: string, result: Record<string, any>): void {
	ipc.appendEvent({ type: 'rebase-result', targetPid: clientPid, requestId, sessionId, ...result })
}

function runRebaseStart(sessionId: string, requestId: string, clientPid: number): void {
	if (agentLoop.isWorking(sessionId)) {
		emitRebaseResult(clientPid, requestId, sessionId, { ok: false, errors: ['Session is working'] })
		return
	}
	const entries = sessionStore.loadHistory(sessionId)
	const baseLog = sessionStore.loadSessionMeta(sessionId)?.currentLog ?? 'history.asonl'
	const baseHash = historyHash(entries)
	const snapshot = rebase.buildSnapshot(sessionId, baseLog, entries)
	snapshots.set(requestId, { sessionId, clientPid, baseLog, baseHash, snapshot })
	ipc.appendEvent({ type: 'rebase-start', targetPid: clientPid, requestId, sessionId, todo: rebase.renderTodo(snapshot), editTexts: rebase.editTexts(snapshot) })
}

async function runRebaseApply(sessionId: string, requestId: string, clientPid: number, todo: string, edits: Record<string, string> = {}): Promise<void> {
	const saved = snapshots.get(requestId)
	if (!saved || saved.sessionId !== sessionId) {
		emitRebaseResult(clientPid, requestId, sessionId, { ok: false, errors: ['Rebase request expired'] })
		return
	}
	if (agentLoop.isWorking(sessionId)) {
		emitRebaseResult(clientPid, requestId, sessionId, { ok: false, errors: ['Session is working'] })
		return
	}
	const currentEntries = sessionStore.loadHistory(sessionId)
	const currentLog = sessionStore.loadSessionMeta(sessionId)?.currentLog ?? 'history.asonl'
	if (currentLog !== saved.baseLog || historyHash(currentEntries) !== saved.baseHash) {
		emitRebaseResult(clientPid, requestId, sessionId, { ok: false, errors: ['History changed while editor was open; restart /rebase.'] })
		return
	}
	if (todo === rebase.renderTodo(saved.snapshot) && Object.keys(edits).length === 0) {
		snapshots.delete(requestId)
		emitRebaseResult(clientPid, requestId, sessionId, { ok: true, unchanged: true })
		return
	}
	const parsed = rebase.parseTodo(saved.snapshot, todo, { edits })
	if (parsed.aborted) {
		snapshots.delete(requestId)
		emitRebaseResult(clientPid, requestId, sessionId, { ok: true, aborted: true })
		return
	}
	if (parsed.errors.length > 0) {
		emitRebaseResult(clientPid, requestId, sessionId, { ok: false, errors: parsed.errors, todo })
		return
	}
	let applied
	try {
		applied = await rebase.applyParsed(saved.snapshot, parsed)
		apiMessages.toProviderMessages(sessionId, applied.entries, { prune: false })
	} catch (err) {
		emitRebaseResult(clientPid, requestId, sessionId, { ok: false, errors: [errorMessage(err)], todo })
		return
	}
	if (applied.queue.length === 0 && historyHash(applied.entries) === historyHash(currentEntries)) {
		snapshots.delete(requestId)
		emitRebaseResult(clientPid, requestId, sessionId, { ok: true, unchanged: true })
		return
	}
	const { oldLog, newLog, entryCount } = sessionStore.rewriteHistoryForRebase(sessionId, applied.entries)
	openai.resetSession(sessionId)
	snapshots.delete(requestId)
	ipc.appendEvent({ type: 'history-rebased', sessionId, oldLog, newLog, entryCount })
	for (const text of applied.queue) await runtime.enqueuePrompt(sessionId, text)
	emitRebaseResult(clientPid, requestId, sessionId, { ok: true, newLog, queued: applied.queue.length })
}

export const rebaseHandler = { snapshots, runRebaseStart, runRebaseApply }
