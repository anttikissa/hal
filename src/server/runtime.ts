// Server runtime — watches commands and dispatches to agent loop.
//
// Broadcasts session list via IPC. Clients load history directly from disk.

import { rebaseHandler } from './rebase-handler.ts'
import { tabs } from './tabs.ts'
import { queueRunner } from './queue-runner.ts'
import { modelNotices } from './model-notices.ts'
import { ipc } from '../ipc.ts'
import { protocol } from '../protocol.ts'
import type { Command, SpawnCommandData, SpawnKind } from '../protocol.ts'
import { models } from '../models.ts'
import { sessions as sessionStore, type HistoryEntry, type SessionMeta, type UserPart } from './sessions.ts'
import { commands } from '../runtime/commands.ts'
import type { SessionState } from '../runtime/commands.ts'
import { agentLoop, type AgentLoopResult } from '../runtime/agent-loop.ts'
import { context } from '../runtime/system-prompt.ts'
import { apiMessages } from '../session/api-messages.ts'
import { attachments } from '../session/attachments.ts'
import { sessionIds } from '../session/ids.ts'
import { replay } from '../session/replay.ts'
import { openaiUsage } from '../openai-usage.ts'
import { toolRegistry } from '../tools/tool.ts'
import { log } from '../utils/log.ts'
import { startup } from '../startup.ts'
import { promptQueue } from '../runtime/prompt-queue.ts'
import { openai } from '../providers/openai.ts'
import { paths } from '../utils/paths.ts'
import { openingSummary } from '../session/opening-summary.ts'
import { blob } from '../session/blob.ts'
import { whatSummary } from '../session/what.ts'

type PendingContinuation = { canceled: boolean }
type PendingPrompt = {
	controller: AbortController
	task: Promise<void>
}
const state = {
	openSessionIds: [] as string[],
	currentSessionId: null as string | null,
	activeRuntimePid: null as number | null,
	stopPromptWatch: null as (() => void) | null,
	/** Prompt commands that have started dispatching but do not yet have an agent controller. */
	pendingPrompts: new Map<string, PendingPrompt>(),
	/** Resumed local-tool batches need their own controller before a provider turn exists. */
	pendingToolRuns: new Map<string, AbortController>(),
	/** Continuations that are waiting for the turn they replace to finish. */
	continuingTurns: new Map<string, PendingContinuation>(),
}

const USER_PAUSED_TEXT = '[paused]'
const RESUMING_TEXT = '[resuming]'
const RESTARTED_TEXT = '[restarted]'
const TAB_CLOSED_TEXT = 'Tab closed'

const pendingWhatResults = new Map<string, string[]>()

function emitBackgroundActivity(sessionId: string, activity: 'summarizing', active: boolean, done = false): void {
	ipc.updateState((shared) => {
		shared.summarizing ??= {}
		if (active) shared.summarizing[sessionId] = true
		else delete shared.summarizing[sessionId]
	})
	ipc.appendEvent({ type: 'background-activity', sessionId, activity, active, done, createdAt: new Date().toISOString() })
}

function persistWhatResult(sessionId: string, targetIds: string[], text: string): void {
	if (agentLoop.isWorking(sessionId)) {
		const pending = pendingWhatResults.get(sessionId) ?? []
		pending.push(text)
		pendingWhatResults.set(sessionId, pending)
		return
	}
	whatSummary.persistResult(sessionId, targetIds, text)
	emitBackgroundActivity(sessionId, 'summarizing', false, true)
}

function flushPendingWhatResults(sessionId: string): void {
	const pending = pendingWhatResults.get(sessionId)
	if (!pending) return
	pendingWhatResults.delete(sessionId)
	for (const text of pending) whatSummary.persistResult(sessionId, [sessionId], text)
	emitBackgroundActivity(sessionId, 'summarizing', false, true)
}

type SpawnSpec = SpawnCommandData

function errorMessage(err: unknown): string { return err instanceof Error ? err.message : String(err) }

function promptCommandName(text: string): string {
	const command = text.trimStart().match(/^\/(\S+)/)?.[1]
	return command ? `/${command}` : 'command'
}

function formatCommandError(text: string, error: string): string {
	const command = promptCommandName(text)
	if (error.startsWith(`${command}:`)) return error
	return `${command}: ${error}`
}

function broadcastSessions(): void { tabs.syncSharedState(); restartPromptWatch() }

function emitInfo(sessionId: string, text: string, level: 'info' | 'error' = 'info', ui?: 'notice', retryable?: boolean, usageBars?: true): void {
	const createdAt = new Date().toISOString()
	const entry: HistoryEntry = ui === 'notice'
		? { type: 'info', text, ts: createdAt, ui, ...(usageBars ? { usageBars } : {}) }
		: { type: 'log', text, ts: createdAt, ...(level === 'error' ? { level: 'error' as const } : {}), ...(usageBars ? { usageBars } : {}) }
	sessionStore.appendHistorySync(sessionId, [entry])
	ipc.appendEvent({
		id: protocol.eventId(),
		type: 'info',
		text,
		level,
		...(ui ? { ui } : {}),
		...(retryable === false ? { retryable: false } : {}),
		...(usageBars ? { usageBars } : {}),
		sessionId,
		createdAt,
	})
}

function shouldCloseSessionAfterGeneration(meta: { spawnKind?: SpawnKind } | null | undefined, result: AgentLoopResult): boolean {
	return meta?.spawnKind === 'subagent' && result === 'completed'
}

function restartedAfterLastTurnEnd(entries: HistoryEntry[]): boolean {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!
		if (entry.type === 'turn_end') return false
		if (entry.type === 'log' && entry.text === RESTARTED_TEXT) return true
	}
	return false
}

function shouldAutoContinue(entries: HistoryEntry[]): boolean {
	return restartedAfterLastTurnEnd(entries) && sessionStore.tailTurnState(entries).interrupted
}

function shouldShowResumingNotice(sessionId: string): boolean {
	for (const entry of sessionStore.loadHistory(sessionId).toReversed()) {
		if (entry.type === 'log' && entry.text === RESUMING_TEXT) return false
		if (entry.type === 'pending_tools' && entry.reason === 'soft-pause') return true
		if (entry.type === 'turn_end' && entry.status === 'aborted' && !!entry.abortText) return true
		if (entry.type === 'log' && (entry.text === USER_PAUSED_TEXT || entry.text === '[paused before local tools]' || entry.text.startsWith('[interrupted]'))) return true
		if (entry.type !== 'log' && entry.type !== 'info') return false
	}
	return false
}

function stateModel(model?: string): string { return model ?? models.defaultModel() }

function recordSessionStateChanges(sessionId: string, prevCwd: string, nextCwd: string, prevModel?: string, nextModel?: string, ts = new Date().toISOString()): void {
	const entries: HistoryEntry[] = []
	if (prevCwd !== nextCwd) entries.push({ type: 'cwd', from: prevCwd, to: nextCwd, visibility: 'next-user', ts })
	const fromModel = stateModel(prevModel)
	const toModel = stateModel(nextModel)
	if (fromModel !== toModel) entries.push({ type: 'model', from: fromModel, to: toModel, visibility: 'next-user', ts })
	if (entries.length > 0) sessionStore.appendHistorySync(sessionId, entries)
}

function buildSpawnPrompt(parentId: string, task: string, kind: SpawnKind): string {
	return [
		`You are a subagent working for parent session ${parentId}.`,
		'',
		'Task:',
		task,
		'',
		`When finished, send a concise handoff to session ${parentId} using the send tool. Include summary, files changed, and open questions.`,
		kind === 'subagent'
			? 'After sending the handoff, finish normally and Hal will close this tab for you.'
			: 'After sending the handoff, leave this tab open for the user to inspect.'
	].join('\n')
}

function queuePromptCommand(sessionId: string, text: string, source?: string, queue?: boolean): void { ipc.appendCommand({ type: 'prompt', sessionId, text, source, queue, createdAt: new Date().toISOString() }) }

function spawnSession(parent: SessionMeta, spec: SpawnSpec): SessionMeta {
	const mode = spec.mode === 'fresh' ? 'fresh' : 'fork'
	// Resolve model/cwd before creating the tab so the opening summary banner
	// (written during creation) reports the spawned model, not the default.
	const model = models.resolveModel(spec.model || parent.model || models.defaultModel())
	const child = tabs.createSessionTab(
		mode === 'fork'
			? { sourceId: parent.id, sessionId: spec.childSessionId, focus: false }
			: {
				afterId: parent.id,
				sessionId: spec.childSessionId,
				workingDir: spec.cwd || parent.workingDir || process.cwd(),
				model,
				focus: false,
			},
	)
	const workingDir = spec.cwd || child.workingDir || process.cwd()
	const name = spec.title || child.name
	sessionStore.updateMeta(child.id, {
		workingDir,
		model,
		name,
		spawnKind: spec.kind,
		parentSessionId: parent.id,
	})
	if (mode === 'fresh' || spec.cwd || spec.model) publishContextEstimate(child.id)
	if (spec.kind === 'subagent') {
		tabs.recordSessionInfo(child.id, 'This subagent will close itself after sending a handoff.', new Date().toISOString())
	}
	return sessionStore.loadSessionMeta(child.id) ?? child
}

async function startSpawnedSession(parent: SessionMeta, child: SessionMeta, spec: SpawnSpec): Promise<void> {
	const text = spec.kind === 'interactive' ? spec.task : buildSpawnPrompt(parent.id, spec.task, spec.kind)
	// Blank interactive tab: nothing to inject, just publish it.
	if (!text.trim()) {
		broadcastSessions()
		return
	}
	const ts = new Date().toISOString()
	// The initial prompt is injected by the parent, so it retains its source in
	// the transcript. Keep an explicit recall entry as well: it is the child
	// user's only way to inspect exactly what was started after switching tabs.
	//
	// Write the user entry straight to history instead of emitting a 'prompt'
	// event. Clients learn about the new tab from the session list and build it
	// from history, so a prompt event would race the tab creation and render the
	// same message a second time.
	sessionStore.appendHistorySync(child.id, [
		{ type: 'input_history', text, ts },
		{ type: 'user', parts: await resolvePromptParts(child.id, text), source: parent.id, ts },
	])
	broadcastSessions()
	await runGeneration(child.id, '')
}
function restartPromptWatch(): void {
	state.stopPromptWatch?.()
	state.stopPromptWatch = context.watchPromptFiles(
		tabs.openSessionMetas().map((meta) => ({ sessionId: meta.id, cwd: meta.workingDir ?? process.cwd() })),
		(change) => {
			emitInfo(change.sessionId, `[system reload] ${change.name} changed: ${change.path}`)
		},
	)
}

function recordTabClosed(sessionId: string): void {
	if (!agentLoop.abort(sessionId, TAB_CLOSED_TEXT)) emitInfo(sessionId, TAB_CLOSED_TEXT)
}

// Handled slash commands never become user entries, so persist the typed text
// as input_history for up-arrow recall after restart. Commands arriving from
// subagents or the inbox carry a source and are not human keystrokes.
function persistCommandInput(sessionId: string, text: string, source?: string): void {
	if (source) return
	sessionStore.appendHistorySync(sessionId, [{ type: 'input_history', text, ts: new Date().toISOString() }])
}

function buildSessionState(meta: SessionMeta): SessionState {
	return {
		id: meta.id,
		name: meta.name ?? '',
		model: meta.model,
		cwd: meta.workingDir ?? process.cwd(),
		createdAt: meta.createdAt,
		sessions: tabs.openSessionMetas().map((item) => ({ id: item.id, name: tabs.sessionTitle(item) })),
	}
}

async function handlePrompt(sessionId: string, text: string, label?: 'steering' | 'queued', source?: string, displayText?: string, pending?: PendingPrompt): Promise<void> {
	if (!ipc.ownsHostLock()) return
	const meta = sessionStore.loadSessionMeta(sessionId)
	if (!meta) return
	if (await queueRunner.handleQueueSlashCommand(sessionId, text, source, displayText)) {
		persistCommandInput(sessionId, text, source)
		return
	}
	const sessionState = buildSessionState(meta)
	const prevName = sessionState.name
	const prevModel = sessionState.model
	const prevCwd = sessionState.cwd
	const cmdResult = await commands.executeCommand(text, sessionState, {
		info: (message, level) => emitInfo(sessionId, message, level),
	})
	if (cmdResult.handled) {
		persistCommandInput(sessionId, text, source)
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
		if (cmdResult.output) {
			if (cmdResult.syntheticKind) {
				modelNotices.emitSyntheticAssistant(sessionId, cmdResult.output, cmdResult.syntheticKind, sessionState.model ?? models.defaultModel())
			} else {
				emitInfo(sessionId, cmdResult.output, 'info', cmdResult.ui, undefined, cmdResult.usageBars)
			}
		}
		if (cmdResult.error) emitInfo(sessionId, formatCommandError(text, cmdResult.error), 'error', undefined, false)
		if (label === 'steering' && !cmdResult.error && /^\/model\b/.test(text.trimStart())) void runGeneration(sessionId, '', source)
		return
	}
	ipc.appendEvent({
		type: 'prompt',
		text: displayText ?? text,
		actualText: displayText && displayText !== text ? text : undefined,
		label,
		source,
		sessionId,
		createdAt: new Date().toISOString(),
	})
	await runGeneration(sessionId, text, source, displayText, pending)
}

async function dispatchPromptCommand(sessionId: string, text: string, source: string | undefined, displayText: string | undefined, pending: PendingPrompt, label?: 'queued'): Promise<void> {
	const steering = agentLoop.isWorking(sessionId)
	if (steering && await queueRunner.handleQueueSlashCommand(sessionId, text, source, displayText, true)) {
		persistCommandInput(sessionId, text, source)
		return
	}
	if (steering && commands.canRunWhileWorking(text)) {
		await handlePrompt(sessionId, text, undefined, source, displayText)
		return
	}
	if (steering) {
		const settled = agentLoop.abortAndWait(sessionId)
		if (settled) await settled
	}
	await runtime.handlePrompt(sessionId, text, label ?? (steering ? 'steering' : undefined), source, displayText, pending)
}

function trackPendingPrompt(sessionId: string, run: (pending: PendingPrompt, previous?: PendingPrompt) => Promise<void>): Promise<void> {
	const previous = state.pendingPrompts.get(sessionId)
	const pending: PendingPrompt = { controller: new AbortController(), task: Promise.resolve() }
	state.pendingPrompts.set(sessionId, pending)
	pending.task = run(pending, previous)
	function clear(): void {
		if (state.pendingPrompts.get(sessionId) === pending) state.pendingPrompts.delete(sessionId)
	}
	void pending.task.then(clear, clear)
	return pending.task
}

function startPromptCommand(sessionId: string, text: string, source?: string, displayText?: string, label?: 'queued'): Promise<void> {
	return trackPendingPrompt(sessionId, (pending) => dispatchPromptCommand(sessionId, text, source, displayText, pending, label))
}

function startPromptAmendCommand(sessionId: string, text: string, source?: string, displayText?: string): Promise<void> {
	return trackPendingPrompt(sessionId, (pending, previous) => handlePromptAmendCommand(sessionId, text, source, displayText, pending, previous))
}

function abortPendingPrompt(sessionId: string, abortText: string): Promise<void> | false {
	const pending = state.pendingPrompts.get(sessionId)
	if (!pending) return false
	pending.controller.abort(abortText)
	return pending.task
}

async function resolvePromptParts(sessionId: string, text: string, displayText?: string): Promise<UserPart[]> {
	if (displayText && displayText !== text) return [{ type: 'text', text, displayText }]
	return (await attachments.resolve(sessionId, text)).logParts
}

function hasTurnContentAfterLastUser(entries: HistoryEntry[]): boolean {
	let lastUser = -1
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i]?.type === 'user') {
			lastUser = i
			break
		}
	}
	if (lastUser < 0) return true
	for (const entry of entries.slice(lastUser + 1)) {
		if (entry.type === 'assistant' || entry.type === 'thinking' || entry.type === 'tool_call' || entry.type === 'tool_result') return true
	}
	return false
}

function hasLiveTurnContent(sessionId: string): boolean {
	for (const block of sessionStore.loadLive(sessionId).blocks) {
		if (block?.type === 'assistant' || block?.type === 'thinking' || block?.type === 'tool') return true
	}
	return false
}

async function continueTurn(sessionId: string, continuation: PendingContinuation): Promise<void> {
	const pending = abortPendingPrompt(sessionId, '')
	if (pending) await pending
	if (agentLoop.isWorking(sessionId)) {
		if (agentLoop.hasPauseBeforeTools(sessionId)) return
		const settled = agentLoop.abortAndWait(sessionId, '')
		if (settled) await settled
	}
	if (continuation.canceled) return
	// Continuing resumes the paused turn that held the queue. If it completes,
	// queued prompts should drain immediately instead of staying stuck behind
	// the paused-turn safety hold.
	if (shouldShowResumingNotice(sessionId)) emitInfo(sessionId, RESUMING_TEXT)
	promptQueue.setHeld(sessionId, false)
	await continuePendingTools(sessionId)
	if (continuation.canceled) return
	void runGeneration(sessionId, '')
}

function requestContinue(sessionId: string): void {
	if (state.continuingTurns.has(sessionId)) return
	const continuation = { canceled: false }
	state.continuingTurns.set(sessionId, continuation)
	const task = continueTurn(sessionId, continuation)
	void task.then(
		() => { if (state.continuingTurns.get(sessionId) === continuation) state.continuingTurns.delete(sessionId) },
		() => { if (state.continuingTurns.get(sessionId) === continuation) state.continuingTurns.delete(sessionId) },
	)
}


async function amendLastPrompt(sessionId: string, text: string, source?: string, displayText?: string): Promise<boolean> {
	const entries = sessionStore.loadHistory(sessionId)
	if (entries.length === 0 || hasTurnContentAfterLastUser(entries) || hasLiveTurnContent(sessionId)) return false
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]
		if (entry?.type !== 'user') continue
		entries[i] = {
			type: 'user',
			parts: await resolvePromptParts(sessionId, text, displayText),
			source,
			ts: entry.ts ?? new Date().toISOString(),
		}
		const { oldLog, newLog, entryCount } = sessionStore.rewriteHistoryForRebase(sessionId, entries)
		resetProviderConversation(sessionId)
		sessionStore.clearLive(sessionId)
		ipc.appendEvent({ type: 'history-rebased', sessionId, oldLog, newLog, entryCount })
		return true
	}
	return false
}

async function handlePromptAmendCommand(sessionId: string, text: string, source: string | undefined, displayText: string | undefined, pending: PendingPrompt, previous?: PendingPrompt): Promise<void> {
	if (!text.trim()) return
	if (previous) {
		previous.controller.abort('')
		await previous.task
	}
	if (agentLoop.isWorking(sessionId)) {
		const settled = agentLoop.abortAndWait(sessionId, '')
		if (settled) await settled
	}
	if (!await amendLastPrompt(sessionId, text, source, displayText)) {
		const canceled = sessionStore.cancelTailTurn(sessionId)
		if (canceled) {
			resetProviderConversation(sessionId)
			sessionStore.clearLive(sessionId)
			ipc.appendEvent({ type: 'history-rebased', sessionId, newLog: canceled.logName, entryCount: canceled.entryCount })
		}
		await handlePrompt(sessionId, text, undefined, source, displayText, pending)
		return
	}
	await runGeneration(sessionId, '', undefined, undefined, pending)
}

async function continuePendingTools(sessionId: string): Promise<boolean> {
	const pending = sessionStore.findPendingTools(sessionId)
	if (!pending) return false
	// Pending tools must run before provider-message rebuild; otherwise
	// repairToolPairing() would correctly treat the missing tool results as an
	// interruption and inject synthetic [interrupted] results.
	const ac = new AbortController()
	state.pendingToolRuns.set(sessionId, ac)
	ipc.updateState((shared) => {
		shared.working[sessionId] = true
	})
	try {
		const blobMap = new Map<string, string>()
		const calls = pending.toolCalls.map((call) => {
			if (call.blobId) blobMap.set(call.id, call.blobId)
			const input = call.input === undefined && call.blobId ? blob.readBlob(sessionId, call.blobId)?.call?.input : call.input
			return { id: call.id, name: call.name, input }
		})
		await agentLoop.executeToolBatch(sessionId, calls, pending.cwd, ac.signal, blobMap)
		sessionStore.resolvePendingTools(sessionId, pending.id)
		return true
	} finally {
		if (state.pendingToolRuns.get(sessionId) === ac) state.pendingToolRuns.delete(sessionId)
		ipc.updateState((shared) => {
			delete shared.working[sessionId]
		})
	}
}

async function runGeneration(sessionId: string, text: string, source?: string, displayText?: string, pending?: PendingPrompt): Promise<void> {
	if (!ipc.ownsHostLock()) return
	const meta = sessionStore.loadSessionMeta(sessionId)
	if (!meta) return
	const cwd = meta.workingDir ?? process.cwd()
	const model = meta.model ?? models.defaultModel()
	const promptResult = context.buildSystemPrompt({ model, cwd, sessionId })
	if (text) {
		const pendingTools = sessionStore.findPendingTools(sessionId)
		if (pendingTools) sessionStore.resolvePendingTools(sessionId, pendingTools.id)
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
			signal: pending?.controller.signal,
			onStatus: async (working) => {
				ipc.updateState((state) => {
					if (working) state.working[sessionId] = true
					else delete state.working[sessionId]
				})
			},
		})
	} catch (err: any) {
		emitInfo(sessionId, `Generation failed: ${err?.message ?? String(err)}`, 'error')
	}
	flushPendingWhatResults(sessionId)
	if (shouldCloseSessionAfterGeneration(sessionStore.loadSessionMeta(sessionId), result) && !agentLoop.isWorking(sessionId)) {
		tabs.closeSession(sessionId)
		return
	}
	if (result !== 'completed') queueRunner.emitQueuePausedNotice(sessionId)
	if (!agentLoop.isWorking(sessionId) && queueRunner.shouldDrainQueuedPrompt(sessionId, result)) await queueRunner.runNextQueuedPrompt(sessionId)
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
	if (agentLoop.isWorking(sessionId)) {
		emitInfo(sessionId, 'Session is working')
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
	if (agentLoop.isWorking(sessionId)) {
		emitInfo(sessionId, 'Session is working')
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

function recordClientStatus(cmd: Extract<Command, { type: 'client-status' }>): void {
	ipc.updateState((shared) => {
		shared.clients = (shared.clients ?? []).filter((item) => item.pid !== cmd.pid)
		shared.clients.push({
			pid: cmd.pid,
			startedAt: cmd.startedAt,
			updatedAt: cmd.updatedAt,
			sessionId: cmd.sessionId,
			cwd: cmd.cwd,
			versionStatus: cmd.versionStatus,
			version: cmd.version,
			error: cmd.error,
		})
	})
}

function removeClient(pid: number): void {
	ipc.updateState((shared) => {
		shared.clients = (shared.clients ?? []).filter((item) => item.pid !== pid)
	})
}
function handleCommand(cmd: Command): void {
	const sessionId = cmd.sessionId ?? state.openSessionIds[0]
	if (cmd.type === 'client-status') {
		recordClientStatus(cmd)
		return
	}
	if (cmd.type === 'client-exit') {
		removeClient(cmd.pid)
		return
	}
	tabs.focusSession(cmd.sessionId)
	if (cmd.type === 'focus') {
		broadcastSessions()
		return
	}
	switch (cmd.type) {
		case 'prompt': {
			if (!sessionId) return
			if (cmd.queue) void queueRunner.enqueuePrompt(sessionId, cmd.text, cmd.source, cmd.displayText)
			else startPromptCommand(sessionId, cmd.text, cmd.source, cmd.displayText)
			break
		}
		case 'prompt-amend': {
			if (!sessionId) return
			void startPromptAmendCommand(sessionId, cmd.text, cmd.source, cmd.displayText)
			break
		}
		case 'continue': {
			if (!sessionId) return
			requestContinue(sessionId)
			break
		}
		case 'pause-before-tools': {
			if (!sessionId) return
			if (agentLoop.requestPauseBeforeTools(sessionId)) emitInfo(sessionId, 'Will pause before next local tool batch')
			else emitInfo(sessionId, 'No working turn to pause before local tools')
			break
		}
		case 'run-next-from-queue': {
			if (!sessionId) return
			if (agentLoop.isWorking(sessionId)) emitInfo(sessionId, 'Session is working')
			else void queueRunner.runNextQueuedPrompt(sessionId, false)
			break
		}
		case 'abort': {
			if (!cmd.sessionId) return
			const continuation = state.continuingTurns.get(cmd.sessionId)
			if (continuation) {
				continuation.canceled = true
				state.continuingTurns.delete(cmd.sessionId)
			}
			const abortText = cmd.abortText ?? (promptQueue.load(cmd.sessionId).length > 0 ? '' : USER_PAUSED_TEXT)
			const pending = abortPendingPrompt(cmd.sessionId, abortText)
			const toolRun = state.pendingToolRuns.get(cmd.sessionId)
			toolRun?.abort()
			const working = agentLoop.abort(cmd.sessionId, abortText)
			if (!pending && !toolRun && !working && abortText !== '' && !continuation) emitInfo(cmd.sessionId, 'No working turn to pause')
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
			rebaseHandler.runRebaseStart(sessionId, cmd.requestId, cmd.clientPid)
			break
		}
		case 'rebase-apply': {
			if (!sessionId) return
			void rebaseHandler.runRebaseApply(sessionId, cmd.requestId, cmd.clientPid, cmd.todo, cmd.edits)
			break
		}
		case 'what': {
			if (!sessionId) return
			const resolved = whatSummary.resolveTargets(cmd.target ?? '', sessionId, state.openSessionIds)
			const ids = resolved.ok ? [...new Set(resolved.ids)] : []
			const summarizing = ipc.readState().summarizing ?? {}
			const activityIds = ids.filter((id) => !summarizing[id])
			const skippedIds = ids.filter((id) => summarizing[id])
			if (skippedIds.length > 0) emitInfo(sessionId, `Already summarizing: ${skippedIds.join(', ')}`)
			if (resolved.ok && activityIds.length === 0) return
			for (const id of activityIds) emitBackgroundActivity(id, 'summarizing', true)
			void (async () => {
				try {
					const result = await whatSummary.run({ requesterSessionId: sessionId, target: cmd.target ?? '', targetIds: resolved.ok ? activityIds : undefined, openSessionIds: state.openSessionIds, persist: persistWhatResult })
					if (result.renamed) broadcastSessions()
				} catch (err) {
					emitInfo(sessionId, `/what failed: ${errorMessage(err)}`, 'error', undefined, false)
				} finally {
					for (const id of activityIds) {
						if (!pendingWhatResults.has(id)) emitBackgroundActivity(id, 'summarizing', false)
					}
				}
			})()
			break
		}
		case 'open': {
			log.info('Runtime handling open command', {
				sessionId,
				cwd: 'cwd' in cmd ? cmd.cwd : undefined,
				forceNew: 'forceNew' in cmd ? cmd.forceNew : undefined,
				forkSessionId: 'forkSessionId' in cmd ? cmd.forkSessionId : undefined,
				afterSessionId: 'afterSessionId' in cmd ? cmd.afterSessionId : undefined,
				openSessionIds: state.openSessionIds.length,
				commandCreatedAt: cmd.createdAt,
			})
			if ('forkSessionId' in cmd) {
				const child = tabs.createSessionTab({ sourceId: cmd.forkSessionId, workingDir: cmd.cwd })
				emitInfo(cmd.forkSessionId, `Tab forked to ${tabs.sessionLabel(child)}.`, 'info', 'notice')
			} else if ('cwd' in cmd && cmd.cwd && cmd.forceNew) {
				tabs.createSessionTab({ openerId: sessionId, afterId: sessionId, workingDir: cmd.cwd })
			} else if ('afterSessionId' in cmd) {
				tabs.createSessionTab({ openerId: sessionId, afterId: cmd.afterSessionId })
			} else if (cmd.cwd) {
				const target = tabs.activateTargetForCwd(cmd.cwd)
				if (!target.ok) {
					const sid = sessionId ?? state.openSessionIds[0]
					if (sid) emitInfo(sid, target.reason, 'error')
					break
				}
			} else {
				tabs.createSessionTab({ openerId: sessionId })
			}
			broadcastSessions()
			break
		}
		case 'spawn': {
			if (!sessionId) return
			const parent = sessionStore.loadSessionMeta(sessionId)
			if (!parent) return
			let kind: SpawnKind = 'subagent'
			if (cmd.spawn.kind === 'subagent-leave-open' || cmd.spawn.kind === 'interactive') kind = cmd.spawn.kind
			if (kind !== 'interactive' && !cmd.spawn.task.trim()) {
				emitInfo(sessionId, 'Spawn task is required unless kind is interactive', 'error')
				break
			}
			const spec: SpawnSpec = {
				task: cmd.spawn.task,
				kind,
				mode: cmd.spawn.mode === 'fresh' ? 'fresh' : 'fork',
				model: cmd.spawn.model,
				cwd: cmd.spawn.cwd,
				title: cmd.spawn.title,
				childSessionId:
					typeof cmd.spawn.childSessionId === 'string' && cmd.spawn.childSessionId.trim()
						? cmd.spawn.childSessionId.trim()
						: undefined,
			}
			const child = spawnSession(parent, spec)
			// No broadcast here: startSpawnedSession publishes the session list once
			// the initial prompt is in history, so clients render it exactly once.
			void startSpawnedSession(parent, child, spec)
			break
		}
		case 'tool-confirm': {
			agentLoop.resolveToolConfirmation(cmd.requestId, cmd.approved)
			break
		}
		case 'resume': {
			const selector = (cmd.selector ?? '').trim()
			const resumeId = sessionStore.resolveResumeTarget(sessionStore.loadAllSessionMetas(), new Set(state.openSessionIds), selector)
			if (!resumeId) {
				emitInfo(
					sessionId ?? state.openSessionIds[0] ?? '',
					selector ? 'No matching closed session.' : 'No closed sessions.',
					selector ? 'error' : 'info',
				)
				break
			}
			const resumed = sessionStore.activateSession(resumeId)
			if (!resumed) {
				emitInfo(sessionId ?? state.openSessionIds[0] ?? resumeId, `Session ${resumeId} not found`, 'error')
				break
			}
			state.openSessionIds = tabs.restoredSessionOrder(state.openSessionIds, resumeId, resumed.closedTabPosition)
			sessionStore.updateMeta(resumeId, { closedAt: undefined })
			tabs.focusSession(resumeId)
			broadcastSessions()
			break
		}
		case 'move': {
			if (!cmd.sessionId || !Number.isFinite(cmd.position)) return
			if (tabs.moveSessionToIndex(cmd.sessionId, cmd.position - 1)) broadcastSessions()
			break
		}
		case 'close': {
			if (!cmd.sessionId) return
			recordTabClosed(cmd.sessionId)
			tabs.closeSession(cmd.sessionId, true)
			break
		}
	}
}
function startRuntime(signal: AbortSignal, opts: { targetCwd?: string } = {}): { ok: true; sessionId?: string } | { ok: false; reason: string } {
	state.activeRuntimePid = process.pid
	state.openSessionIds = []
	state.currentSessionId = null
	state.stopPromptWatch?.()
	state.stopPromptWatch = null
	sessionStore.deactivateAllSessions()
	const metas = sessionStore.loadSessionMetas()
	state.openSessionIds = metas.map((meta) => meta.id)
	state.currentSessionId = state.openSessionIds[0] ?? null
	for (const pending of state.pendingPrompts.values()) pending.controller.abort(RESTARTED_TEXT)
	state.pendingPrompts.clear()
	for (const controller of state.pendingToolRuns.values()) controller.abort()
	state.pendingToolRuns.clear()
	let startupSessionId: string | undefined
	if (opts.targetCwd) {
		const target = tabs.activateTargetForCwd(opts.targetCwd)
		if (!target.ok) return target
		startupSessionId = target.sessionId
	} else if (state.openSessionIds.length === 0) {
		startupSessionId = tabs.createSessionTab({}).id
		if (!signal.aborted && state.activeRuntimePid === process.pid) broadcastSessions()
	}
	restartPromptWatch()
	signal.addEventListener('abort', () => {
		state.stopPromptWatch?.()
		state.stopPromptWatch = null
		const ts = new Date().toISOString()
		for (const sessionId of state.openSessionIds) {
			if (!agentLoop.isWorking(sessionId)) continue
			sessionStore.appendHistorySync(sessionId, [{ type: 'log', text: RESTARTED_TEXT, ts }])
			agentLoop.abort(sessionId, '')
		}
	}, { once: true })
	ipc.updateState((state) => {
		state.working = {}
		state.summarizing = {}
	})
	if (state.openSessionIds.length > 0) tabs.syncSharedState()
	void modelNotices.refreshModelMetadata()
	openaiUsage.start(signal)
	if (metas.length > 0) {
		setTimeout(() => {
			if (signal.aborted || state.activeRuntimePid !== process.pid) return
			broadcastSessions()
		}, 0)
	}
	void (async () => {
		for (const sessionId of state.openSessionIds) {
			if (signal.aborted || state.activeRuntimePid !== process.pid || !ipc.ownsHostLock()) return
			const entries = sessionStore.loadAllHistory(sessionId)
			if (!shouldAutoContinue(entries)) continue
			const tail = sessionStore.tailTurnState(entries)
			for (const tool of tail.interruptedTools) {
				sessionStore.appendHistory(sessionId, [{ type: 'tool_result', toolId: tool.id, output: '[interrupted]', ts: new Date().toISOString() }])
			}
			void runGeneration(sessionId, '')
		}
	})()
	void (async () => {
		for await (const cmd of ipc.tailCommands(signal)) {
			if (signal.aborted || state.activeRuntimePid !== process.pid) break
			if (!ipc.ownsHostLock()) break
			const hasLiveSession = !cmd.sessionId || state.openSessionIds.includes(cmd.sessionId)
			if (!hasLiveSession && cmd.type !== 'client-exit' && cmd.type !== 'client-status' && cmd.type !== 'open' && cmd.type !== 'resume') continue
			try {
				handleCommand(cmd)
			} catch (err: any) {
				const sid = cmd.sessionId ?? state.openSessionIds[0]
				if (sid) emitInfo(sid, `Command error: ${err?.message ?? String(err)}`, 'error', undefined, false)
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
				if (!state.openSessionIds.includes(sessionId)) return
				queuePromptCommand(sessionId, text, source, queue)
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
	recordTabClosed,
	spawnSession,
	startSpawnedSession,
	formatCommandError,
	handlePrompt,
	runCompact,
	handleCommand,
	continuePendingTools,
	startPromptCommand,
	// Used by sibling server modules (tabs, model-notices) at call time.
	broadcastSessions,
	publishContextEstimate,
}
