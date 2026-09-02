// Model metadata refresh notices — models.dev refresh on startup plus
// synthetic assistant suggestions for alias updates and new model discoveries.

import { ipc } from './file-ipc.ts'
import { protocol } from '../common/protocol.ts'
import { models } from '../common/models.ts'
import { sessions as sessionStore, type SessionMeta } from './sessions.ts'
import { HAL_DIR } from './state.ts'
import { log } from '../utils/log.ts'
import { modelRefresh } from './model-refresh.ts'
import { serverModels } from './models.ts'
// Circular import with runtime.ts is safe: we only access runtime.* at call time
// (module convention — all cross-module calls go through namespace objects).
import { runtime } from './runtime.ts'
import { tabs } from './tabs.ts'

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err)
}

function emitFocusedInfo(text: string): void {
	const sessionId = tabs.focusedSessionId()
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


function modelDiscoveryTarget(): SessionMeta | null {
	const openerId = tabs.focusedSessionId() ?? tabs.openSessionMetas()[0]?.id
	if (!openerId) return null
	const child = tabs.createSessionTab({ openerId, afterId: openerId, workingDir: HAL_DIR, focus: false })
	sessionStore.updateMeta(child.id, { name: 'model updates' })
	runtime.broadcastSessions()
	return sessionStore.loadSessionMeta(child.id) ?? child
}

function suggestModelDiscoveries(previous: Record<string, number>, next: Record<string, number>): void {
	const discoveries = models.modelDiscoveries(previous, next).filter((item) => {
		return serverModels.hasConfiguredDirectSource(item.model) && item.context > 0 && !/(embedding|image|tts|live|realtime|computer|robotics|omni)/.test(item.model)
	})
	const updates = models.aliasUpdateSuggestions(previous, next)
	if (discoveries.length === 0 && updates.length === 0) return
	const meta = modelDiscoveryTarget()
	if (!meta) return
	const model = meta.model ?? models.defaultModel()
	modelNotices.emitSyntheticAssistant(meta.id, modelRefresh.buildNewModelDiscoveryText(discoveries, updates), 'model-discovery', model)
}

async function refreshModelMetadata(): Promise<void> {
	try {
		const checked = await modelRefresh.checkModels()
		const result = checked.result
		// New-model notices below are actionable and replace the raw catalog delta.
		// Context changes remain quiet unless that model has a configured direct route.
		const changes = result.changes.filter((change) => {
			if (change.startsWith('new ')) return false
			return serverModels.hasConfiguredDirectSource(change.split(' context ')[0]!)
		})
		if (!result.hadCache || changes.length > 0) {
			const message = modelRefresh.formatModelRefreshMessage(changes, result.modelCount)
			log.info('models.dev metadata refreshed', { message })
			emitFocusedInfo(message)
		}
		if (result.hadCache) {
			modelNotices.suggestModelDiscoveries(result.previous, result.next)
		}
	} catch (err) {
		log.error('models.dev refresh failed', { error: errorMessage(err) })
	}
}

export const modelNotices = {
	refreshModelMetadata,
	suggestModelDiscoveries,
	emitSyntheticAssistant,
}
