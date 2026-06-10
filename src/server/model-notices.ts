// Model metadata refresh notices — models.dev refresh on startup plus
// synthetic assistant suggestions for alias updates and new model discoveries.

import { ipc } from '../ipc.ts'
import { protocol } from '../protocol.ts'
import { models } from '../models.ts'
import { sessions as sessionStore, type SessionMeta } from './sessions.ts'
import { agentLoop } from '../runtime/agent-loop.ts'
import { HAL_DIR } from '../state.ts'
import { log } from '../utils/log.ts'
import { modelRefresh } from '../model-refresh.ts'
// Circular import with runtime.ts is safe: we only access runtime.* at call time
// (module convention — all cross-module calls go through namespace objects).
import { runtime } from './runtime.ts'

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err)
}

function emitFocusedInfo(text: string): void {
	const sessionId = runtime.focusedSessionId()
	if (!sessionId) return
	runtime.emitInfo(sessionId, text)
}

function emitSyntheticAssistant(sessionId: string, text: string, syntheticKind: string, model: string): void {
	const ts = new Date().toISOString()
	sessionStore.appendHistorySync(sessionId, [{ type: 'assistant', text, model, synthetic: true, syntheticKind, ts }])
	ipc.appendEvent({
		id: protocol.eventId(),
		type: 'response',
		text,
		sessionId,
		model,
		synthetic: true,
		createdAt: ts,
	})
}

function suggestAliasUpdates(previous: Record<string, number>, next: Record<string, number>): void {
	const updates = models.aliasUpdateSuggestions(previous, next)
	if (updates.length === 0) return
	const metas = runtime.openSessionMetas()
	const meta = metas.find((item) => item.workingDir === HAL_DIR) ?? metas[0]
	if (!meta) return
	const model = meta.model ?? models.defaultModel()
	emitSyntheticAssistant(meta.id, modelRefresh.buildAliasUpdateSuggestionText(updates, meta.workingDir ?? process.cwd()), 'alias-update-suggestion', model)
}

function sessionWillProduceOutput(sessionId: string): boolean {
	if (agentLoop.isWorking(sessionId)) return true
	return runtime.shouldAutoContinue(sessionStore.loadAllHistory(sessionId))
}

function modelDiscoveryTarget(): SessionMeta | null {
	const focused = runtime.focusedSessionId()
	if (focused && sessionWillProduceOutput(focused)) {
		const child = runtime.createSessionTab({ openerId: focused, afterId: focused, workingDir: HAL_DIR, focus: false })
		sessionStore.updateMeta(child.id, { name: 'new models' })
		runtime.broadcastSessions()
		return sessionStore.loadSessionMeta(child.id) ?? child
	}
	const metas = runtime.openSessionMetas()
	return metas.find((item) => item.id === focused) ?? metas[0] ?? null
}

function suggestModelDiscoveries(previous: Record<string, number>, next: Record<string, number>): void {
	const discoveries = models.modelDiscoveries(previous, next)
	if (discoveries.length === 0) return
	const meta = modelDiscoveryTarget()
	if (!meta) return
	const model = meta.model ?? models.defaultModel()
	emitSyntheticAssistant(meta.id, modelRefresh.buildNewModelDiscoveryText(discoveries, meta.workingDir ?? process.cwd()), 'model-discovery', model)
}

async function refreshModelMetadata(): Promise<void> {
	try {
		const checked = await modelRefresh.checkModels()
		const result = checked.result
		if (!result.hadCache || result.changes.length > 0) {
			log.info('models.dev metadata refreshed', { message: checked.message })
			emitFocusedInfo(checked.message)
		}
		if (result.hadCache) {
			modelNotices.suggestAliasUpdates(result.previous, result.next)
			modelNotices.suggestModelDiscoveries(result.previous, result.next)
		}
	} catch (err) {
		log.error('models.dev refresh failed', { error: errorMessage(err) })
	}
}

export const modelNotices = {
	refreshModelMetadata,
	suggestAliasUpdates,
	suggestModelDiscoveries,
	emitSyntheticAssistant,
}
