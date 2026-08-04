// Tab/session lifecycle — opening, closing, focusing, ordering and resuming
// session tabs. Tab order state lives in runtime.state; this module owns the
// operations on it.

import { ipc } from '../ipc.ts'
import { models } from '../models.ts'
import { sessions as sessionStore, type SessionMeta } from './sessions.ts'
import { sessionIds } from '../session/ids.ts'
import { openingSummary } from '../session/opening-summary.ts'
import { startup } from '../startup.ts'
import { log } from '../utils/log.ts'
import { paths } from '../utils/paths.ts'
// Circular import with runtime.ts is safe: we only access runtime.* at call time
// (module convention — all cross-module calls go through namespace objects).
import { runtime } from './runtime.ts'

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

function planTargetForCwd(cwd: string): ReturnType<typeof startup.planTarget> {
	return startup.planTarget({
		cwd,
		openSessions: openSessionMetas().map((meta) => sessionStore.sessionOpenInfo(meta)),
		allSessions: sessionStore.loadAllSessionMetas(),
	})
}

function activateTargetForCwd(cwd: string): { ok: true; sessionId: string } | { ok: false; reason: string } {
	const plan = planTargetForCwd(cwd)
	log.info('Runtime planned cwd activation', { cwd, plan: plan.kind, sessionId: 'sessionId' in plan ? plan.sessionId : undefined })
	if (plan.kind === 'use-open') return { ok: true, sessionId: plan.sessionId }
	if (plan.kind === 'refuse') return { ok: false, reason: plan.reason }
	if (plan.kind === 'resume') {
		const resumed = sessionStore.activateSession(plan.sessionId)
		if (!resumed) return { ok: false, reason: `Session ${plan.sessionId} not found` }
		runtime.state.openSessionIds = restoredSessionOrder(runtime.state.openSessionIds, plan.sessionId, resumed.closedTabPosition)
		sessionStore.updateMeta(plan.sessionId, { closedAt: undefined })
		focusSession(plan.sessionId)
		return { ok: true, sessionId: plan.sessionId }
	}
	const created = tabs.createSessionTab({ workingDir: cwd })
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
	sessionTitle,
	sessionLabel,
	openSessionMetas,
	focusSession,
	focusedSessionId,
	insertSessionAfter,
	restoredSessionOrder,
	moveSessionToIndex,
	activateTargetForCwd,
	recordSessionInfo,
	createSessionTab,
	closeSession,
	syncSharedState,
}
