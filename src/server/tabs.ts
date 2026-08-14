// Tab/session lifecycle — opening, closing, focusing, ordering and resuming
// session tabs. Tab order state lives in runtime.state; this module owns the
// operations on it.

import { ipc } from './file-ipc.ts'
import { models } from '../common/models.ts'
import { sessions as sessionStore, type SessionMeta } from './sessions.ts'
import { sessionIds } from './session/ids.ts'
import { openingSummary } from './session/opening-summary.ts'
import { resolve } from 'path'
import { log } from '../utils/log.ts'
import { paths } from './paths.ts'
import { tabLimit } from './tab-limit.ts'
// Circular import with runtime.ts is safe: we only access runtime.* at call time
// (module convention — all cross-module calls go through namespace objects).
import { runtime } from './runtime.ts'

type OpenSessionLike = { id: string; cwd: string }

function sessionTitle(meta: Pick<SessionMeta, 'id' | 'name'>): string {
	return meta.name ?? meta.id
}

function sessionLabel(meta: Pick<SessionMeta, 'id' | 'name'>): string {
	const title = sessionTitle(meta)
	if (title === meta.id) return meta.id
	return `${title} (${meta.id})`
}

function openSessionMetas(): SessionMeta[] {
	return runtime.state.openSessionIds
		.map((sessionId) => sessionStore.loadSessionMeta(sessionId))
		.filter((meta): meta is SessionMeta => !!meta)
}

function focusSession(sessionId: string | null | undefined): void {
	if (!sessionId) return
	if (!runtime.state.openSessionIds.includes(sessionId)) return
	runtime.state.currentSessionId = sessionId
	sessionStore.updateMeta(sessionId, { attention: undefined })
}

function focusedSessionId(): string | null {
	const { currentSessionId, openSessionIds } = runtime.state
	if (currentSessionId && openSessionIds.includes(currentSessionId)) return currentSessionId
	return openSessionIds[0] ?? null
}

function insertSessionAfter(sessionId: string, afterId?: string): void {
	const { openSessionIds } = runtime.state
	if (!afterId) {
		openSessionIds.push(sessionId)
		return
	}
	const idx = openSessionIds.findIndex((id) => id === afterId)
	if (idx < 0) {
		openSessionIds.push(sessionId)
		return
	}
	openSessionIds.splice(idx + 1, 0, sessionId)
}

function restoredSessionOrder(openSessionIds: string[], sessionId: string, closedTabPosition?: number): string[] {
	const next = openSessionIds.filter((id) => id !== sessionId)
	const targetIndex = Number.isFinite(closedTabPosition) && (closedTabPosition ?? 0) > 0 ? Math.max(0, Math.min(next.length, Math.floor(closedTabPosition as number) - 1)) : next.length
	next.splice(targetIndex, 0, sessionId)
	return next
}

function moveSessionToIndex(sessionId: string, targetIndex: number): boolean {
	const { openSessionIds } = runtime.state
	const fromIndex = openSessionIds.findIndex((id) => id === sessionId)
	if (fromIndex < 0) return false
	const clampedIndex = Math.max(0, Math.min(openSessionIds.length - 1, targetIndex))
	if (fromIndex === clampedIndex) return false
	const [id] = openSessionIds.splice(fromIndex, 1)
	if (!id) return false
	openSessionIds.splice(clampedIndex, 0, id)
	return true
}

function normalizeCwd(cwd: string | undefined): string {
	return resolve(cwd || '.')
}

function sameCwd(a: string | undefined, b: string | undefined): boolean {
	return tabs.normalizeCwd(a) === tabs.normalizeCwd(b)
}

function findOpenSessionForCwd(openSessions: OpenSessionLike[], cwd: string): string | null {
	return openSessions.find((session) => tabs.sameCwd(session.cwd, cwd))?.id ?? null
}

function openLimitReason(cwd?: string): string | null {
	if (runtime.state.openSessionIds.length < tabs.config.maxTabs) return null
	if (cwd) return `Cannot open ${tabs.normalizeCwd(cwd)}: max tabs reached (${tabs.config.maxTabs}). Close one first.`
	return `Max tabs reached (${tabs.config.maxTabs}). Close one first.`
}

function openSessionForCwd(cwd: string): { ok: true; sessionId: string } | { ok: false; reason: string } {
	const normalizedCwd = tabs.normalizeCwd(cwd)
	const openSessions = tabs.openSessionMetas().map((meta) => sessionStore.sessionOpenInfo(meta))
	const openId = tabs.findOpenSessionForCwd(openSessions, normalizedCwd)
	if (openId) {
		tabs.focusSession(openId)
		log.info('Runtime selected open session for cwd', { cwd: normalizedCwd, sessionId: openId })
		return { ok: true, sessionId: openId }
	}

	const limitReason = tabs.openLimitReason(normalizedCwd)
	if (limitReason) return { ok: false, reason: limitReason }

	const created = tabs.createSessionTab({ workingDir: normalizedCwd })
	log.info('Runtime created session for cwd', { cwd: normalizedCwd, sessionId: created.id })
	return { ok: true, sessionId: created.id }
}

function recordSessionInfo(sessionId: string, text: string, ts: string, ui?: 'notice'): void {
	sessionStore.appendHistorySync(sessionId, [{ type: 'info', text, ts, ...(ui ? { ui } : {}) }])
}

function recordOpeningSummary(meta: SessionMeta): void {
	recordSessionInfo(meta.id, openingSummary.text({
		sessionId: meta.id,
		cwd: meta.workingDir,
		currentLog: meta.currentLog,
		model: meta.model,
	}), meta.createdAt)
}

function createSessionTab(opts: { openerId?: string; afterId?: string; sourceId?: string; sessionId?: string; workingDir?: string; model?: string; focus?: boolean }): SessionMeta {
	const sessionId = opts.sessionId ?? sessionIds.reserve()
	const sourceMeta = opts.sourceId ? sessionStore.loadSessionMeta(opts.sourceId) : null
	const openerMeta = opts.openerId ? sessionStore.loadSessionMeta(opts.openerId) : null
	const inheritedModel = opts.model ?? sourceMeta?.model ?? openerMeta?.model ?? models.defaultModel()
	const inheritedWorkingDir = opts.workingDir ?? openerMeta?.workingDir ?? process.cwd()
	const meta = opts.sourceId
		? sessionStore.forkSession(opts.sourceId, sessionId)
		: sessionStore.createSession(sessionId, {
			id: sessionId,
			workingDir: inheritedWorkingDir,
			createdAt: new Date().toISOString(),
			name: undefined,
			model: inheritedModel,
		})
	const overridesForkCwd = !!opts.sourceId && !!opts.workingDir && meta.workingDir !== opts.workingDir
	if (opts.workingDir && meta.workingDir !== opts.workingDir) {
		sessionStore.updateMeta(sessionId, { workingDir: opts.workingDir })
	}
	sessionStore.updateMeta(sessionId, { attention: 'new' })
	insertSessionAfter(sessionId, opts.sourceId ?? opts.afterId)
	if (opts.focus !== false) focusSession(sessionId)
	if (!opts.sourceId) recordOpeningSummary(sessionStore.loadSessionMeta(sessionId) ?? meta)
	const related = sourceMeta ?? openerMeta
	const text = opts.sourceId
		? related ? `Tab forked from ${sessionLabel(related)}; now writing to ${paths.historyDisplayPath(sessionId, meta.currentLog)}` : ''
		: ''
	if (text) recordSessionInfo(sessionId, text, meta.createdAt, 'notice')
	if (opts.sourceId && sourceMeta?.context && !overridesForkCwd) sessionStore.updateMeta(sessionId, { context: sourceMeta.context })
	else runtime.publishContextEstimate(sessionId)
	return sessionStore.loadSessionMeta(sessionId) ?? meta
}

function closeSession(sessionId: string, openReplacement = false): void {
	const { state } = runtime
	sessionStore.updateMeta(sessionId, { closedAt: new Date().toISOString(), closedTabPosition: state.openSessionIds.findIndex((id) => id === sessionId) + 1 })
	sessionStore.deactivateSession(sessionId)
	state.openSessionIds = state.openSessionIds.filter((id) => id !== sessionId)
	if (state.currentSessionId === sessionId) state.currentSessionId = state.openSessionIds[0] ?? null
	if (openReplacement && state.openSessionIds.length === 0) tabs.createSessionTab({})
	runtime.broadcastSessions()
}

function syncSharedState(): void {
	const openMetas = openSessionMetas()
	const openIds = new Set(openMetas.map((meta) => meta.id))
	ipc.updateState((shared) => {
		shared.sessions = openMetas.map(sessionStore.sessionOpenInfo)
		for (const sessionId of Object.keys(shared.working)) {
			if (!openIds.has(sessionId)) delete shared.working[sessionId]
		}
	})
}

export const tabs = {
	config: tabLimit.config,
	normalizeCwd,
	sameCwd,
	findOpenSessionForCwd,
	openLimitReason,
	sessionTitle,
	sessionLabel,
	openSessionMetas,
	focusSession,
	focusedSessionId,
	insertSessionAfter,
	restoredSessionOrder,
	moveSessionToIndex,
	openSessionForCwd,
	recordSessionInfo,
	createSessionTab,
	closeSession,
	syncSharedState,
}
