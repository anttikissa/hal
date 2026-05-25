// Server runtime — watches commands and dispatches to agent loop.
//
// Broadcasts session list via IPC. Clients load history directly from disk.

import { createHash } from 'crypto'
import { ipc } from '../ipc.ts'
import { protocol } from '../protocol.ts'
import type { Command, SpawnCommandData } from '../protocol.ts'
import { models } from '../models.ts'
import { sessions as sessionStore, type HistoryEntry, type SessionMeta, type UserPart } from './sessions.ts'
import { commands } from '../runtime/commands.ts'
import type { SessionState } from '../runtime/commands.ts'
import { agentLoop, type AgentLoopResult } from '../runtime/agent-loop.ts'
import { context } from '../runtime/context.ts'
import { apiMessages } from '../session/api-messages.ts'
import { rebase, type RebaseSnapshot } from '../session/rebase.ts'
import { attachments } from '../session/attachments.ts'
import { sessionIds } from '../session/ids.ts'
import { replay } from '../session/replay.ts'
import { HAL_DIR } from '../state.ts'
import { config } from '../config.ts'
import { openaiUsage } from '../openai-usage.ts'
import { toolRegistry } from '../tools/tool.ts'
import { log } from '../utils/log.ts'
import { startup } from '../startup.ts'
import { promptQueue, type QueuedPrompt } from '../runtime/prompt-queue.ts'
import { openai } from '../providers/openai.ts'

const state = {
	activeSessions: [] as string[],
	activeRuntimePid: null as number | null,
	stopPromptWatch: null as (() => void) | null,
}

const rebaseSnapshots = new Map<string, { sessionId: string; clientPid: number; baseLog: string; baseHash: string; snapshot: RebaseSnapshot }>()

const USER_PAUSED_TEXT = '[paused]'
const RESTARTED_TEXT = '[restarted]'
const TAB_CLOSED_TEXT = 'Tab closed'

type SpawnSpec = SpawnCommandData

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err)
}

function sessionTitle(meta: Pick<SessionMeta, 'id' | 'name' | 'topic'>): string {
	return meta.name ?? meta.topic ?? meta.id
}

function sessionLabel(meta: Pick<SessionMeta, 'id' | 'name' | 'topic'>): string {
	const title = sessionTitle(meta)
	if (title === meta.id) return meta.id
	return `${title} (${meta.id})`
}

function activeMetas(): SessionMeta[] {
	return state.activeSessions
		.map((sessionId) => sessionStore.loadSessionMeta(sessionId))
		.filter((meta): meta is SessionMeta => !!meta)
}

function planTargetForCwd(cwd: string): ReturnType<typeof startup.planTarget> {
	return startup.planTarget({
		cwd,
		openSessions: activeMetas().map((meta) => sessionStore.sessionOpenInfo(meta)),
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
		state.activeSessions = restoredSessionOrder(state.activeSessions, plan.sessionId, resumed.closedTabPosition)
		sessionStore.updateMeta(plan.sessionId, { closedAt: undefined })
		return { ok: true, sessionId: plan.sessionId }
	}
	const created = createSessionTab({ workingDir: cwd })
	return { ok: true, sessionId: created.id }
}

function insertSessionAfter(sessionId: string, afterId?: string): void {
	if (!afterId) {
		state.activeSessions.push(sessionId)
		return
	}
	const idx = state.activeSessions.findIndex((id) => id === afterId)
	if (idx < 0) {
		state.activeSessions.push(sessionId)
		return
	}
	state.activeSessions.splice(idx + 1, 0, sessionId)
}

function restoredSessionOrder(activeSessions: string[], sessionId: string, closedTabPosition?: number): string[] {
	const next = activeSessions.filter((id) => id !== sessionId)
	const targetIndex = Number.isFinite(closedTabPosition) && (closedTabPosition ?? 0) > 0 ? Math.max(0, Math.min(next.length, Math.floor(closedTabPosition as number) - 1)) : next.length
	next.splice(targetIndex, 0, sessionId)
	return next
}

function moveSessionToIndex(sessionId: string, targetIndex: number): boolean {
	const fromIndex = state.activeSessions.findIndex((id) => id === sessionId)
	if (fromIndex < 0) return false
	const clampedIndex = Math.max(0, Math.min(state.activeSessions.length - 1, targetIndex))
	if (fromIndex === clampedIndex) return false
	const [id] = state.activeSessions.splice(fromIndex, 1)
	if (!id) return false
	state.activeSessions.splice(clampedIndex, 0, id)
	return true
}

function syncSharedState(): void {
	const openMetas = activeMetas()
	const openIds = new Set(openMetas.map((meta) => meta.id))
	ipc.updateState((state) => {
		state.sessions = openMetas.map(sessionStore.sessionOpenInfo)
		for (const sessionId of Object.keys(state.busy)) {
			if (!openIds.has(sessionId)) delete state.busy[sessionId]
		}
		for (const sessionId of Object.keys(state.activity)) {
			if (!openIds.has(sessionId)) delete state.activity[sessionId]
		}
	})
}

function broadcastSessions(): void {
	syncSharedState()
	restartPromptWatch()
}

function emitInfo(sessionId: string, text: string, level: 'info' | 'error' = 'info', ui?: 'notice'): void {
	ipc.appendEvent({
		id: protocol.eventId(),
		type: 'info',
		text,
		level,
		...(ui ? { ui } : {}),
		sessionId,
		createdAt: new Date().toISOString(),
	})
}

function shouldCloseSessionAfterGeneration(
	meta: { closeWhenDone?: boolean } | null | undefined,
	result: AgentLoopResult,
): boolean {
	return !!meta?.closeWhenDone && result === 'completed'
}

type TailEntry = { type: string; text?: string; ts?: string; toolId?: string; name?: string; synthetic?: boolean }
type TailTurnState = { shouldContinue: boolean; interruptedTools: { name: string; id: string }[] }

function tailTurnState(entries: TailEntry[], now = Date.now()): TailTurnState {
	let sawRestart = false
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!
		if (entry.type === 'log') {
			if (entry.text === USER_PAUSED_TEXT || entry.text === TAB_CLOSED_TEXT) return { shouldContinue: false, interruptedTools: [] }
			if (entry.text === RESTARTED_TEXT) sawRestart = true
			continue
		}
		if (entry.type === 'assistant' && entry.synthetic) continue
		if (entry.type === 'assistant') return { shouldContinue: false, interruptedTools: [] }
		if (entry.type === 'tool_call') return { shouldContinue: true, interruptedTools: sessionStore.detectInterruptedTools(entries as any) }
		if (entry.type !== 'user' && entry.type !== 'thinking' && entry.type !== 'tool_result') continue

		const ms = entry.ts ? Date.parse(entry.ts) : now
		return { shouldContinue: sawRestart || (Number.isFinite(ms) && now - ms <= 30_000), interruptedTools: [] }
	}
	return { shouldContinue: false, interruptedTools: [] }
}

function shouldAutoContinue(entries: TailEntry[], now = Date.now()): boolean { return tailTurnState(entries, now).shouldContinue }

function recordSessionInfo(sessionId: string, text: string, ts: string, ui?: 'notice'): void {
	sessionStore.appendHistorySync(sessionId, [{ type: 'info', text, ts, ...(ui ? { ui } : {}) }])
}


function stateModel(model?: string): string {
	return model ?? models.defaultModel()
}

function recordSessionStateChanges(sessionId: string, prevCwd: string, nextCwd: string, prevModel?: string, nextModel?: string, ts = new Date().toISOString()): void {
	const entries: HistoryEntry[] = []
	if (prevCwd !== nextCwd) entries.push({ type: 'cwd', from: prevCwd, to: nextCwd, visibility: 'next-user', ts })
	const fromModel = stateModel(prevModel)
	const toModel = stateModel(nextModel)
	if (fromModel !== toModel) entries.push({ type: 'model', from: fromModel, to: toModel, visibility: 'next-user', ts })
	if (entries.length > 0) sessionStore.appendHistorySync(sessionId, entries)
}

function createSessionTab(opts: { openerId?: string; afterId?: string; sourceId?: string; sessionId?: string; workingDir?: string }): SessionMeta {
	const sessionId = opts.sessionId ?? sessionIds.reserve()
	const sourceMeta = opts.sourceId ? sessionStore.loadSessionMeta(opts.sourceId) : null
	const openerMeta = opts.openerId ? sessionStore.loadSessionMeta(opts.openerId) : null
	const inheritedModel = sourceMeta?.model ?? openerMeta?.model ?? models.defaultModel()
	const inheritedWorkingDir = opts.workingDir ?? openerMeta?.workingDir ?? process.cwd()
	const meta = opts.sourceId
		? sessionStore.forkSession(opts.sourceId, sessionId)
		: sessionStore.createSession(sessionId, {
			id: sessionId,
			workingDir: inheritedWorkingDir,
			createdAt: new Date().toISOString(),
			name: undefined,
			topic: undefined,
			model: inheritedModel,
		})
	const overridesForkCwd = !!opts.sourceId && !!opts.workingDir && meta.workingDir !== opts.workingDir
	if (opts.workingDir && meta.workingDir !== opts.workingDir) {
		sessionStore.updateMeta(sessionId, { workingDir: opts.workingDir })
	}
	insertSessionAfter(sessionId, opts.sourceId ?? opts.afterId)
	const related = sourceMeta ?? openerMeta
	const text = opts.sourceId
		? related ? `Tab forked from ${sessionLabel(related)}.` : ''
		: ''
	if (text) recordSessionInfo(sessionId, text, meta.createdAt, 'notice')
	if (opts.sourceId && sourceMeta?.context && !overridesForkCwd) sessionStore.updateMeta(sessionId, { context: sourceMeta.context })
	else publishContextEstimate(sessionId)
	return sessionStore.loadSessionMeta(sessionId) ?? meta
}

function buildSpawnPrompt(parentId: string, task: string, closeWhenDone: boolean): string {
	return [
		`You are a subagent working for parent session ${parentId}.`,
		'',
		'Task:',
		task,
		'',
		`When finished, send a concise handoff to session ${parentId} using the send tool. Include summary, files changed, and open questions.`,
		closeWhenDone
			? 'After sending the handoff, finish normally and Hal will close this tab for you.'
			: 'After sending the handoff, stay open so the user can inspect the tab.',
	].join('\n')
}

function queuePromptCommand(sessionId: string, text: string, source?: string, delivery?: 'queue'): void { ipc.appendCommand({ type: 'prompt', sessionId, text, source, delivery, createdAt: new Date().toISOString() }) }

function spawnSession(parent: SessionMeta, spec: SpawnSpec): SessionMeta {
	const mode = spec.mode === 'fresh' ? 'fresh' : 'fork'
	const child = createSessionTab(
		mode === 'fork'
			? { sourceId: parent.id, sessionId: spec.childSessionId }
			: { afterId: parent.id, sessionId: spec.childSessionId },
	)
	const workingDir = spec.cwd || (mode === 'fork' ? child.workingDir : parent.workingDir) || process.cwd()
	const model = spec.model || (mode === 'fork' ? child.model : parent.model) || child.model || models.defaultModel()
	const name = spec.title || child.name
	sessionStore.updateMeta(child.id, {
		workingDir,
		model,
		name,
		topic: spec.title || child.name,
		closeWhenDone: !!spec.closeWhenDone,
	})
	if (mode === 'fresh' || spec.cwd || spec.model) publishContextEstimate(child.id)
	if (spec.closeWhenDone) {
		recordSessionInfo(child.id, 'This subagent will close itself after sending a handoff.', new Date().toISOString())
	}
	return sessionStore.loadSessionMeta(child.id) ?? child
}

async function startSpawnedSession(parent: SessionMeta, child: SessionMeta, spec: SpawnSpec): Promise<void> {
	await dispatchPromptCommand(child.id, buildSpawnPrompt(parent.id, spec.task, !!spec.closeWhenDone), parent.id)
}
function restartPromptWatch(): void {
	state.stopPromptWatch?.()
	state.stopPromptWatch = context.watchPromptFiles(
		activeMetas().map((meta) => ({ sessionId: meta.id, cwd: meta.workingDir ?? process.cwd() })),
		(change) => {
			emitInfo(change.sessionId, `[system reload] ${change.name} changed: ${change.path}`)
		},
	)
}

function broadcastInfo(text: string, level: 'info' | 'error' = 'info'): void {
	const ts = new Date().toISOString()
	for (const sessionId of state.activeSessions) {
		// Startup metadata refresh can finish before a just-started client begins
		// tailing IPC events. Persist the notice too so it survives that race and
		// remains visible in history after reloads.
		recordSessionInfo(sessionId, text, ts)
		emitInfo(sessionId, text, level)
	}
}

function formatModelRefreshMessage(changes: string[], modelCount?: number): string {
	if (changes.length === 0) return `Fetched recent data from models.dev (${modelCount ?? 0} models)`
	const shown = changes.slice(0, 8)
	const more = changes.length > shown.length ? ` (+${changes.length - shown.length} more)` : ''
	return `[models.dev] fetched model metadata; relevant changes: ${shown.join('; ')}${more}`
}

function buildAliasUpdateSuggestionText(updates: Array<{ aliases: string[]; oldModel: string; newModel: string }>, cwd: string): string {
	const lines = [
		'It looks like some of your model aliases got updates:',
		'',
		...updates.map((update) => `- **${update.aliases.join('**, **')}**: **${update.oldModel}** → **${update.newModel}**`),
	]
	const configuredDefault = config.data.models?.default
	if (typeof configuredDefault === 'string') {
		lines.push('', `config.ason sets the default model to **${configuredDefault}**, which currently maps to **${models.resolveModel(configuredDefault)}**.`)
	}
	lines.push('')
	if (cwd === HAL_DIR) lines.push('Would you like me to update those aliases in ~/.hal?')
	else lines.push('Would you like me to spawn a subagent in ~/.hal and update those aliases?')
	return lines.join('\n')
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
	const metas = activeMetas()
	const meta = metas.find((item) => item.workingDir === HAL_DIR) ?? metas[0]
	if (!meta) return
	const model = meta.model ?? models.defaultModel()
	emitSyntheticAssistant(meta.id, buildAliasUpdateSuggestionText(updates, meta.workingDir ?? process.cwd()), 'alias-update-suggestion', model)
}

async function refreshModelMetadata(): Promise<void> {
	try {
		const result = await models.refreshModels()
		if (!result.hadCache || result.changes.length > 0) {
			const message = formatModelRefreshMessage(result.changes, result.modelCount)
			log.info('models.dev metadata refreshed', { message })
			broadcastInfo(message)
		}
		if (result.hadCache) suggestAliasUpdates(result.previous, result.next)
	} catch (err) {
		log.error('models.dev refresh failed', { error: errorMessage(err) })
	}
}

function recordTabClosed(sessionId: string): void {
	if (!agentLoop.abort(sessionId, TAB_CLOSED_TEXT)) emitInfo(sessionId, TAB_CLOSED_TEXT)
}

function persistCommandRetryInput(sessionId: string, text: string, result: Awaited<ReturnType<typeof commands.executeCommand>>): void {
	if (!result.handled || !result.error) return
	sessionStore.appendHistorySync(sessionId, [{ type: 'input_history', text, ts: new Date().toISOString() }])
}

function buildSessionState(meta: SessionMeta): SessionState {
	return {
		id: meta.id,
		name: meta.name ?? '',
		model: meta.model,
		cwd: meta.workingDir ?? process.cwd(),
		createdAt: meta.createdAt,
		sessions: activeMetas().map((item) => ({ id: item.id, name: sessionTitle(item) })),
	}
}

function queuePreviewResult(text: string, max = 80): { text: string; truncated: boolean } {
	let first = text.split('\n')[0]!.trim()
	const truncated = text.includes('\n') || first.length > max
	if (first.length > max) first = first.slice(0, Math.max(0, max - 3)).trimEnd()
	return { text: truncated ? `${first}...` : first, truncated }
}

function queuePreview(text: string, max = 80): string {
	return queuePreviewResult(text, max).text
}

function queueEntry(text: string, source?: string, displayText?: string): QueuedPrompt {
	return {
		text,
		createdAt: new Date().toISOString(),
		...(source ? { source } : {}),
		...(displayText ? { displayText } : {}),
	}
}

async function enqueuePrompt(sessionId: string, text: string, source?: string, displayText?: string): Promise<void> {
	if (!text.trim()) return
	if (!agentLoop.isActive(sessionId) && !promptQueue.isHeld(sessionId)) {
		await handlePrompt(sessionId, text, undefined, source, displayText)
		return
	}
	const count = promptQueue.append(sessionId, queueEntry(text, source, displayText))
	emitInfo(sessionId, `Queued ${count}: ${queuePreview(text)}`)
}

function buildQueuePausedNotice(entries: QueuedPrompt[]): string {
	const count = entries.length
	const noun = count === 1 ? 'prompt is' : 'prompts are'
	const preview = entries[0] ? queuePreviewResult(entries[0].text, 50) : undefined
	const next = preview ? ` Next: **${preview.text}**.` : ''
	const run = count === 1 ? 'run the queued prompt' : 'run queued prompts'
	const discard = count === 1 ? '`/queue clear` to discard it' : '`/queue clear` to discard'
	const show = preview?.truncated ? `, \`/queue\` to show ${count === 1 ? 'it' : 'them'}` : ''
	return `Paused. ${count} queued ${noun} waiting.${next} **ctrl-q** to ${run}${show}, ${discard}.`
}

function emitQueuePausedNotice(sessionId: string): void {
	const entries = promptQueue.load(sessionId)
	if (entries.length === 0) return
	promptQueue.setHeld(sessionId, true)
	emitInfo(sessionId, buildQueuePausedNotice(entries), 'info', 'notice')
}

function shouldDrainQueuedPrompt(sessionId: string, result: AgentLoopResult): boolean {
	return result === 'completed' && !promptQueue.isHeld(sessionId) && promptQueue.load(sessionId).length > 0
}

async function runNextQueuedPrompt(sessionId: string, quiet = true): Promise<boolean> {
	const next = promptQueue.pop(sessionId)
	if (!next) {
		if (!quiet) emitInfo(sessionId, 'Queue is empty')
		return false
	}
	promptQueue.setHeld(sessionId, false)
	await handlePrompt(sessionId, next.text, undefined, next.source, next.displayText)
	return true
}

async function handleQueueSlashCommand(sessionId: string, text: string, source?: string, displayText?: string): Promise<boolean> {
	const match = text.trimStart().match(/^\/queue(?:\s+([\s\S]*))?$/)
	if (!match) return false
	const args = (match[1] ?? '').trim()
	if (!args) {
		const entries = promptQueue.load(sessionId)
		if (entries.length === 0) emitInfo(sessionId, 'Queue is empty')
		else for (let i = 0; i < entries.length; i++) emitInfo(sessionId, `${i + 1}. ${queuePreview(entries[i]!.text)}`)
		return true
	}
	if (args === 'next') {
		await runNextQueuedPrompt(sessionId, false)
		return true
	}
	if (args === 'clear') {
		promptQueue.clear(sessionId)
		emitInfo(sessionId, 'Queue cleared')
		return true
	}
	await enqueuePrompt(sessionId, args, source, displayText)
	return true
}

async function handlePrompt(sessionId: string, text: string, label?: 'steering', source?: string, displayText?: string): Promise<void> {
	if (!ipc.ownsHostLock()) return
	const meta = sessionStore.loadSessionMeta(sessionId)
	if (!meta) return
	if (await handleQueueSlashCommand(sessionId, text, source, displayText)) return
	const sessionState = buildSessionState(meta)
	const prevName = sessionState.name
	const prevModel = sessionState.model
	const prevCwd = sessionState.cwd
	const cmdResult = await commands.executeCommand(text, sessionState, {
		info: (message, level) => emitInfo(sessionId, message, level),
	})
	if (cmdResult.handled) {
		persistCommandRetryInput(sessionId, text, cmdResult)
		const nextName = sessionState.name || undefined
		if (prevCwd !== sessionState.cwd || prevModel !== sessionState.model || prevName !== (nextName ?? '')) {
			sessionStore.updateMeta(sessionId, {
				workingDir: sessionState.cwd,
				model: sessionState.model,
				name: nextName,
			})
			broadcastSessions()
		}
		recordSessionStateChanges(sessionId, prevCwd, sessionState.cwd, prevModel, sessionState.model)
		if (cmdResult.output) emitInfo(sessionId, cmdResult.output, 'info', cmdResult.ui)
		if (cmdResult.error) emitInfo(sessionId, cmdResult.error, 'error')
		if (label === 'steering' && !cmdResult.error && /^\/model\b/.test(text.trimStart())) void runGeneration(sessionId, '', source)
		return
	}
	ipc.appendEvent({
		type: 'prompt',
		text: displayText ?? text,
		label,
		source,
		sessionId,
		createdAt: new Date().toISOString(),
	})
	await runGeneration(sessionId, text, source, displayText)
}

async function dispatchPromptCommand(sessionId: string, text: string, source?: string, displayText?: string): Promise<void> {
	const steering = agentLoop.isActive(sessionId)
	if (steering) {
		agentLoop.abort(sessionId)
		await Bun.sleep(50)
	}
	await handlePrompt(sessionId, text, steering ? 'steering' : undefined, source, displayText)
}

function closeSession(sessionId: string, openReplacement = false): void {
	sessionStore.updateMeta(sessionId, { closedAt: new Date().toISOString(), closeWhenDone: false, closedTabPosition: state.activeSessions.findIndex((id) => id === sessionId) + 1 })
	sessionStore.deactivateSession(sessionId)
	state.activeSessions = state.activeSessions.filter((id) => id !== sessionId)
	if (openReplacement && state.activeSessions.length === 0) createSessionTab({})
	broadcastSessions()
}

async function resolvePromptParts(sessionId: string, text: string, displayText?: string): Promise<UserPart[]> {
	if (displayText && displayText !== text) return [{ type: 'text', text, displayText }]
	return (await attachments.resolve(sessionId, text)).logParts
}

async function runGeneration(sessionId: string, text: string, source?: string, displayText?: string): Promise<void> {
	if (!ipc.ownsHostLock()) return
	const meta = sessionStore.loadSessionMeta(sessionId)
	if (!meta) return
	const cwd = meta.workingDir ?? process.cwd()
	const model = meta.model ?? models.defaultModel()
	const promptResult = context.buildSystemPrompt({ model, cwd, sessionId })
	if (text) {
		sessionStore.appendHistory(sessionId, [{
			type: 'user',
			parts: await resolvePromptParts(sessionId, text, displayText),
			source,
			ts: new Date().toISOString(),
		}])
	}
	const messages = apiMessages.toProviderMessages(sessionId)
	ipc.appendEvent({ type: 'stream-start', sessionId, createdAt: new Date().toISOString() })
	let result: AgentLoopResult = 'failed'
	try {
		result = await agentLoop.runAgentLoop({
			sessionId,
			model,
			cwd,
			systemPrompt: promptResult.text,
			messages,
			onStatus: async (busy, activity) => {
				ipc.updateState((state) => {
					if (busy) state.busy[sessionId] = true
					else delete state.busy[sessionId]
					if (activity) state.activity[sessionId] = activity
					else delete state.activity[sessionId]
				})
			},
		})
	} catch (err: any) {
		emitInfo(sessionId, `Generation failed: ${err?.message ?? String(err)}`, 'error')
	}
	if (shouldCloseSessionAfterGeneration(sessionStore.loadSessionMeta(sessionId), result) && !agentLoop.isActive(sessionId)) {
		closeSession(sessionId)
		return
	}
	if (result !== 'completed') emitQueuePausedNotice(sessionId)
	if (!agentLoop.isActive(sessionId) && shouldDrainQueuedPrompt(sessionId, result)) await runNextQueuedPrompt(sessionId)
}

function publishContextEstimate(sessionId: string): { used: number; max: number } | null {
	const meta = sessionStore.loadSessionMeta(sessionId)
	if (!meta) return null
	const model = meta.model ?? models.defaultModel()
	const promptResult = context.buildSystemPrompt({
		model,
		cwd: meta.workingDir ?? process.cwd(),
		sessionId,
	})
	const overheadBytes = promptResult.text.length + JSON.stringify(toolRegistry.toToolDefs()).length
	const messages = apiMessages.toProviderMessages(sessionId)
	const est = context.estimateContext(messages, model, overheadBytes)
	sessionStore.updateMeta(sessionId, { context: { used: est.used, max: est.max } })
	return { used: est.used, max: est.max }
}

function emitContextEstimate(sessionId: string, estimate: { used: number; max: number } | null): void {
	if (!estimate) return
	ipc.appendEvent({
		type: 'stream-end',
		sessionId,
		contextUsed: estimate.used,
		contextMax: estimate.max,
		createdAt: new Date().toISOString(),
	})
}

function resetProviderConversation(sessionId: string): void {
	openai.resetSession(sessionId)
}

function runReset(sessionId: string): void {
	if (!ipc.ownsHostLock()) return
	if (agentLoop.isActive(sessionId)) {
		emitInfo(sessionId, 'Session is busy')
		return
	}
	const ts = new Date().toISOString()
	const oldLog = sessionStore.loadSessionMeta(sessionId)?.currentLog ?? 'history.asonl'
	sessionStore.rewriteHistoryAfterRotation(sessionId, [
		{ type: 'reset', ts },
		{ type: 'user', parts: [{ type: 'text', text: `[system] Session was reset. Previous conversation: ${oldLog}` }], ts },
	])
	resetProviderConversation(sessionId)
	emitContextEstimate(sessionId, publishContextEstimate(sessionId))
	emitInfo(sessionId, 'Conversation cleared.')
}

function runCompact(sessionId: string): void {
	if (!ipc.ownsHostLock()) return
	if (agentLoop.isActive(sessionId)) {
		emitInfo(sessionId, 'Session is busy')
		return
	}
	const entries = sessionStore.loadHistory(sessionId)
	const userMsgs = entries.filter((entry) => entry.type === 'user')
	if (userMsgs.length === 0) {
		emitInfo(sessionId, 'Nothing to compact')
		return
	}
	const oldLog = sessionStore.loadSessionMeta(sessionId)?.currentLog ?? 'history.asonl'
	const ts = new Date().toISOString()
	const { newLog } = sessionStore.rewriteHistoryAfterRotation(sessionId, [
		{ type: 'compact', ts },
		{ type: 'user', parts: [{ type: 'text', text: `[system] Session was manually compacted. Previous conversation: ${oldLog}` }], ts },
		{ type: 'user', parts: [{ type: 'text', text: replay.buildCompactionContext(sessionId, entries) }], ts },
	])
	resetProviderConversation(sessionId)
	emitContextEstimate(sessionId, publishContextEstimate(sessionId))
	emitInfo(sessionId, `Context compacted (${userMsgs.length} user messages summarized, now writing to ${newLog})`)
}

function historyHash(entries: HistoryEntry[]): string {
	const text = entries.map((entry) => JSON.stringify(entry)).join('\n')
	return createHash('sha256').update(text).digest('hex')
}

function emitRebaseResult(clientPid: number, requestId: string, sessionId: string, result: Record<string, any>): void {
	ipc.appendEvent({ type: 'rebase-result', targetPid: clientPid, requestId, sessionId, ...result })
}

function runRebaseStart(sessionId: string, requestId: string, clientPid: number): void {
	if (agentLoop.isActive(sessionId)) {
		emitRebaseResult(clientPid, requestId, sessionId, { ok: false, errors: ['Session is busy'] })
		return
	}
	const entries = sessionStore.loadHistory(sessionId)
	const baseLog = sessionStore.loadSessionMeta(sessionId)?.currentLog ?? 'history.asonl'
	const baseHash = historyHash(entries)
	const snapshot = rebase.buildSnapshot(sessionId, baseLog, entries)
	rebaseSnapshots.set(requestId, { sessionId, clientPid, baseLog, baseHash, snapshot })
	ipc.appendEvent({ type: 'rebase-start', targetPid: clientPid, requestId, sessionId, todo: rebase.renderTodo(snapshot) })
}

async function runRebaseApply(sessionId: string, requestId: string, clientPid: number, todo: string): Promise<void> {
	const saved = rebaseSnapshots.get(requestId)
	if (!saved || saved.sessionId !== sessionId) {
		emitRebaseResult(clientPid, requestId, sessionId, { ok: false, errors: ['Rebase request expired'] })
		return
	}
	if (agentLoop.isActive(sessionId)) {
		emitRebaseResult(clientPid, requestId, sessionId, { ok: false, errors: ['Session is busy'] })
		return
	}
	const currentEntries = sessionStore.loadHistory(sessionId)
	const currentLog = sessionStore.loadSessionMeta(sessionId)?.currentLog ?? 'history.asonl'
	if (currentLog !== saved.baseLog || historyHash(currentEntries) !== saved.baseHash) {
		emitRebaseResult(clientPid, requestId, sessionId, { ok: false, errors: ['History changed while editor was open; restart /rebase.'] })
		return
	}
	const parsed = rebase.parseTodo(saved.snapshot, todo)
	if (parsed.aborted) {
		rebaseSnapshots.delete(requestId)
		emitRebaseResult(clientPid, requestId, sessionId, { ok: true, aborted: true })
		return
	}
	if (parsed.errors.length > 0) {
		emitRebaseResult(clientPid, requestId, sessionId, { ok: false, errors: parsed.errors, todo })
		return
	}
	let applied
	try {
		applied = rebase.applyParsed(saved.snapshot, parsed)
		apiMessages.toProviderMessages(sessionId, applied.entries, { prune: false })
	} catch (err) {
		emitRebaseResult(clientPid, requestId, sessionId, { ok: false, errors: [errorMessage(err)], todo })
		return
	}
	const { oldLog, newLog, entryCount } = sessionStore.rewriteHistoryForRebase(sessionId, applied.entries)
	resetProviderConversation(sessionId)
	rebaseSnapshots.delete(requestId)
	ipc.appendEvent({ type: 'history-rebased', sessionId, oldLog, newLog, entryCount })
	for (const text of applied.queue) await enqueuePrompt(sessionId, text)
	emitRebaseResult(clientPid, requestId, sessionId, { ok: true, newLog, queued: applied.queue.length })
}

function handleCommand(cmd: Command): void {
	const sessionId = cmd.sessionId ?? state.activeSessions[0]
	switch (cmd.type) {
		case 'prompt': {
			if (!sessionId) return
			if (cmd.delivery === 'queue') void enqueuePrompt(sessionId, cmd.text, cmd.source, cmd.displayText)
			else void dispatchPromptCommand(sessionId, cmd.text, cmd.source, cmd.displayText)
			break
		}
		case 'continue': {
			if (!sessionId) return
			void (async () => {
				if (agentLoop.isActive(sessionId)) {
					agentLoop.abort(sessionId, '')
					await Bun.sleep(50)
				}
				void runGeneration(sessionId, '')
			})()
			break
		}
		case 'queue-next': {
			if (!sessionId) return
			if (agentLoop.isActive(sessionId)) emitInfo(sessionId, 'Session is busy')
			else void runNextQueuedPrompt(sessionId, false)
			break
		}
		case 'abort': {
			if (!cmd.sessionId) return
			if (!agentLoop.abort(cmd.sessionId, promptQueue.load(cmd.sessionId).length > 0 ? '' : USER_PAUSED_TEXT)) emitInfo(cmd.sessionId, 'No active generation to abort')
			break
		}
		case 'reset': {
			if (!sessionId) return
			runReset(sessionId)
			break
		}
		case 'compact': {
			if (!sessionId) return
			runCompact(sessionId)
			break
		}
		case 'rebase-start': {
			if (!sessionId) return
			runRebaseStart(sessionId, cmd.requestId, cmd.clientPid)
			break
		}
		case 'rebase-apply': {
			if (!sessionId) return
			void runRebaseApply(sessionId, cmd.requestId, cmd.clientPid, cmd.todo)
			break
		}
		case 'open': {
			log.info('Runtime handling open command', {
				sessionId,
				cwd: 'cwd' in cmd ? cmd.cwd : undefined,
				forceNew: 'forceNew' in cmd ? cmd.forceNew : undefined,
				forkSessionId: 'forkSessionId' in cmd ? cmd.forkSessionId : undefined,
				afterSessionId: 'afterSessionId' in cmd ? cmd.afterSessionId : undefined,
				activeSessions: state.activeSessions.length,
				commandCreatedAt: cmd.createdAt,
			})
			if ('forkSessionId' in cmd) {
				const child = createSessionTab({ sourceId: cmd.forkSessionId, workingDir: cmd.cwd })
				emitInfo(cmd.forkSessionId, `Tab forked to ${sessionLabel(child)}.`, 'info', 'notice')
			} else if ('cwd' in cmd && cmd.cwd && cmd.forceNew) {
				createSessionTab({ openerId: sessionId, afterId: sessionId, workingDir: cmd.cwd })
			} else if ('afterSessionId' in cmd) {
				createSessionTab({ openerId: sessionId, afterId: cmd.afterSessionId })
			} else if (cmd.cwd) {
				const target = activateTargetForCwd(cmd.cwd)
				if (!target.ok) {
					const sid = sessionId ?? state.activeSessions[0]
					if (sid) emitInfo(sid, target.reason, 'error')
					break
				}
			} else {
				createSessionTab({ openerId: sessionId })
			}
			broadcastSessions()
			break
		}
		case 'spawn': {
			if (!sessionId) return
			const parent = sessionStore.loadSessionMeta(sessionId)
			if (!parent) return
			if (!cmd.spawn.task.trim()) {
				emitInfo(sessionId, 'Spawn task is required', 'error')
				break
			}
			const spec: SpawnSpec = {
				task: cmd.spawn.task,
				mode: cmd.spawn.mode === 'fresh' ? 'fresh' : 'fork',
				model: cmd.spawn.model,
				cwd: cmd.spawn.cwd,
				title: cmd.spawn.title,
				closeWhenDone: !!cmd.spawn.closeWhenDone,
				childSessionId:
					typeof cmd.spawn.childSessionId === 'string' && cmd.spawn.childSessionId.trim()
						? cmd.spawn.childSessionId.trim()
						: undefined,
			}
			const child = spawnSession(parent, spec)
			broadcastSessions()
			void startSpawnedSession(parent, child, spec)
			break
		}
		case 'tool-confirm': {
			agentLoop.resolveToolConfirmation(cmd.requestId, cmd.approved)
			break
		}
		case 'resume': {
			const selector = (cmd.selector ?? '').trim()
			const resumeId = sessionStore.resolveResumeTarget(sessionStore.loadAllSessionMetas(), new Set(state.activeSessions), selector)
			if (!resumeId) {
				emitInfo(
					sessionId ?? state.activeSessions[0] ?? '',
					selector ? 'No matching closed session.' : 'No closed sessions.',
					selector ? 'error' : 'info',
				)
				break
			}
			const resumed = sessionStore.activateSession(resumeId)
			if (!resumed) {
				emitInfo(sessionId ?? state.activeSessions[0] ?? resumeId, `Session ${resumeId} not found`, 'error')
				break
			}
			state.activeSessions = restoredSessionOrder(state.activeSessions, resumeId, resumed.closedTabPosition)
			sessionStore.updateMeta(resumeId, { closedAt: undefined })
			broadcastSessions()
			break
		}
		case 'move': {
			if (!cmd.sessionId || !Number.isFinite(cmd.position)) return
			if (moveSessionToIndex(cmd.sessionId, cmd.position - 1)) broadcastSessions()
			break
		}
		case 'close': {
			if (!cmd.sessionId) return
			recordTabClosed(cmd.sessionId)
			closeSession(cmd.sessionId, true)
			break
		}
	}
}

function startRuntime(signal: AbortSignal, opts: { targetCwd?: string } = {}): { ok: true; sessionId?: string } | { ok: false; reason: string } {
	state.activeRuntimePid = process.pid
	state.activeSessions = []
	state.stopPromptWatch?.()
	state.stopPromptWatch = null
	sessionStore.deactivateAllSessions()
	const metas = sessionStore.loadSessionMetas()
	state.activeSessions = metas.map((meta) => meta.id)
	let startupSessionId: string | undefined
	if (opts.targetCwd) {
		const target = activateTargetForCwd(opts.targetCwd)
		if (!target.ok) return target
		startupSessionId = target.sessionId
	} else if (state.activeSessions.length === 0) {
		startupSessionId = createSessionTab({}).id
		if (!signal.aborted && state.activeRuntimePid === process.pid) broadcastSessions()
	}
	restartPromptWatch()
	signal.addEventListener('abort', () => {
		state.stopPromptWatch?.()
		state.stopPromptWatch = null
		const ts = new Date().toISOString()
		for (const sessionId of state.activeSessions) {
			if (!agentLoop.isActive(sessionId)) continue
			sessionStore.appendHistorySync(sessionId, [{ type: 'log', text: RESTARTED_TEXT, ts }])
			agentLoop.abort(sessionId, '')
		}
	}, { once: true })
	ipc.updateState((state) => {
		state.busy = {}
		state.activity = {}
	})
	if (state.activeSessions.length > 0) syncSharedState()
	void refreshModelMetadata()
	openaiUsage.start(signal)
	if (metas.length > 0) {
		setTimeout(() => {
			if (signal.aborted || state.activeRuntimePid !== process.pid) return
			broadcastSessions()
		}, 0)
	}
	void (async () => {
		for (const sessionId of state.activeSessions) {
			if (signal.aborted || state.activeRuntimePid !== process.pid || !ipc.ownsHostLock()) return
			const entries = sessionStore.loadAllHistory(sessionId)
			if (entries.length === 0) continue
			const tail = tailTurnState(entries)
			if (tail.interruptedTools.length > 0) {
				emitInfo(sessionId, `Resolving ${tail.interruptedTools.length} interrupted tool(s): ${tail.interruptedTools.map((tool) => tool.name).join(', ')}`)
				for (const tool of tail.interruptedTools) {
					sessionStore.appendHistory(sessionId, [{
						type: 'tool_result',
						toolId: tool.id,
						output: '[interrupted]',
						ts: new Date().toISOString(),
					}])
				}
			}
			if (tail.shouldContinue) void runGeneration(sessionId, '')
		}
	})()
	void (async () => {
		for await (const cmd of ipc.tailCommands(signal)) {
			if (signal.aborted || state.activeRuntimePid !== process.pid) break
			if (!ipc.ownsHostLock()) break
			const hasLiveSession = !cmd.sessionId || state.activeSessions.includes(cmd.sessionId)
			if (!hasLiveSession && cmd.type !== 'open' && cmd.type !== 'resume') continue
			try {
				handleCommand(cmd)
			} catch (err: any) {
				const sid = cmd.sessionId ?? state.activeSessions[0]
				if (sid) emitInfo(sid, `Command error: ${err?.message ?? String(err)}`, 'error')
			}
		}
	})()
	void import('../mcp/client.ts')
		.then(({ mcp }) => {
			mcp.initServers().catch((err: any) => {
				log.error('mcp init failed', { error: err?.message ?? String(err) })
			})
			signal.addEventListener('abort', () => {
				void mcp.shutdown()
			}, { once: true })
		})
		.catch((err) => {
			log.error('mcp client module load failed', { error: errorMessage(err) })
		})
	void import('../runtime/inbox.ts')
		.then(({ inbox }) => {
			inbox.startWatching(signal, (sessionId, text, source, queue) => {
				if (!state.activeSessions.includes(sessionId)) return
				queuePromptCommand(sessionId, text, source, queue ? 'queue' : undefined)
			})
		})
		.catch((err) => {
			log.error('inbox module load failed', { error: errorMessage(err) })
		})
	return { ok: true, sessionId: startupSessionId }
}

export const runtime = {
	state,
	startRuntime,
	emitInfo,
	shouldAutoContinue,
	shouldCloseSessionAfterGeneration,
	restoredSessionOrder,
	recordTabClosed,
	spawnSession,
	startSpawnedSession,
	refreshModelMetadata,
	formatModelRefreshMessage,
	buildAliasUpdateSuggestionText,
	suggestAliasUpdates,
	enqueuePrompt,
	handleQueueSlashCommand,
	runNextQueuedPrompt,
	buildQueuePausedNotice,
	shouldDrainQueuedPrompt,
	runCompact,
	handleCommand,
}
