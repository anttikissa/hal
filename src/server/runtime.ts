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
import { context } from '../runtime/context.ts'
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
import { whatSummary } from '../session/what.ts'

const state = {
	openSessionIds: [] as string[],
	currentSessionId: null as string | null,
	activeRuntimePid: null as number | null,
	stopPromptWatch: null as (() => void) | null,
}

const USER_PAUSED_TEXT = '[paused]'
const RESTARTED_TEXT = '[restarted]'
const TAB_CLOSED_TEXT = 'Tab closed'

type SpawnSpec = SpawnCommandData

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err)
}

function promptCommandName(text: string): string {
	const match = text.trimStart().match(/^\/(\S+)/)
	return match ? `/${match[1]}` : 'command'
}

function formatCommandError(text: string, error: string): string {
	const command = promptCommandName(text)
	if (error.startsWith(`${command}:`)) return error
	return `${command}: ${error}`
}

function broadcastSessions(): void {
	tabs.syncSharedState()
	restartPromptWatch()
}

function emitInfo(sessionId: string, text: string, level: 'info' | 'error' = 'info', ui?: 'notice', retryable?: boolean): void {
	const createdAt = new Date().toISOString()
	const entry: HistoryEntry = ui === 'notice'
		? { type: 'info', text, ts: createdAt, ui }
		: { type: 'log', text, ts: createdAt, ...(level === 'error' ? { level: 'error' as const } : {}) }
	sessionStore.appendHistorySync(sessionId, [entry])
	ipc.appendEvent({
		id: protocol.eventId(),
		type: 'info',
		text,
		level,
		...(ui ? { ui } : {}),
		...(retryable === false ? { retryable: false } : {}),
		sessionId,
		createdAt,
	})
}

function shouldCloseSessionAfterGeneration(
	meta: { spawnKind?: SpawnKind } | null | undefined,
	result: AgentLoopResult,
): boolean {
	return meta?.spawnKind === 'subagent-autoclose' && result === 'completed'
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

function buildSpawnPrompt(parentId: string, task: string, kind: SpawnKind): string {
	return [
		`You are a subagent working for parent session ${parentId}.`,
		'',
		'Task:',
		task,
		'',
		`When finished, send a concise handoff to session ${parentId} using the send tool. Include summary, files changed, and open questions.`,
		kind === 'subagent-autoclose'
			? 'After sending the handoff, finish normally and Hal will close this tab for you.'
			: 'After sending the handoff, stay open so the user can inspect the tab.',
	].join('\n')
}

function queuePromptCommand(sessionId: string, text: string, source?: string, delivery?: 'queue'): void { ipc.appendCommand({ type: 'prompt', sessionId, text, source, delivery, createdAt: new Date().toISOString() }) }

function spawnSession(parent: SessionMeta, spec: SpawnSpec): SessionMeta {
	const mode = spec.mode === 'fresh' ? 'fresh' : 'fork'
	const child = tabs.createSessionTab(
		mode === 'fork'
			? { sourceId: parent.id, sessionId: spec.childSessionId, focus: false }
			: { afterId: parent.id, sessionId: spec.childSessionId, focus: false },
	)
	const workingDir = spec.cwd || (mode === 'fork' ? child.workingDir : parent.workingDir) || process.cwd()
	const model = spec.model || (mode === 'fork' ? child.model : parent.model) || child.model || models.defaultModel()
	const name = spec.title || child.name
	sessionStore.updateMeta(child.id, {
		workingDir,
		model,
		name,
		spawnKind: spec.kind,
		parentSessionId: parent.id,
	})
	if (mode === 'fresh' || spec.cwd || spec.model) publishContextEstimate(child.id)
	if (spec.kind === 'subagent-autoclose') {
		tabs.recordSessionInfo(child.id, 'This subagent will close itself after sending a handoff.', new Date().toISOString())
	}
	return sessionStore.loadSessionMeta(child.id) ?? child
}

async function startSpawnedSession(parent: SessionMeta, child: SessionMeta, spec: SpawnSpec): Promise<void> {
	if (spec.kind === 'interactive') {
		if (spec.task.trim()) await dispatchPromptCommand(child.id, spec.task, parent.id)
		return
	}
	await dispatchPromptCommand(child.id, buildSpawnPrompt(parent.id, spec.task, spec.kind), parent.id)
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
		sessions: tabs.openSessionMetas().map((item) => ({ id: item.id, name: tabs.sessionTitle(item) })),
	}
}

async function handlePrompt(sessionId: string, text: string, label?: 'steering' | 'queued', source?: string, displayText?: string): Promise<void> {
	if (!ipc.ownsHostLock()) return
	const meta = sessionStore.loadSessionMeta(sessionId)
	if (!meta) return
	if (await queueRunner.handleQueueSlashCommand(sessionId, text, source, displayText)) return
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
		if (cmdResult.error) emitInfo(sessionId, formatCommandError(text, cmdResult.error), 'error', undefined, false)
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
	const steering = agentLoop.isWorking(sessionId)
	if (steering && await queueRunner.handleQueueSlashCommand(sessionId, text, source, displayText, true)) return
	if (steering && commands.canRunWhileWorking(text)) {
		await handlePrompt(sessionId, text, undefined, source, displayText)
		return
	}
	if (steering) {
		agentLoop.abort(sessionId)
		await Bun.sleep(50)
	}
	await handlePrompt(sessionId, text, steering ? 'steering' : undefined, source, displayText)
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

async function amendLastPrompt(sessionId: string, text: string, source?: string, displayText?: string): Promise<boolean> {
	const entries = sessionStore.loadHistory(sessionId)
	if (entries.length === 0 || hasTurnContentAfterLastUser(entries)) return false
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

async function handlePromptAmendCommand(sessionId: string, text: string, source?: string, displayText?: string): Promise<void> {
	if (!text.trim()) return
	if (agentLoop.isWorking(sessionId)) {
		agentLoop.abort(sessionId, '')
		await Bun.sleep(50)
	}
	if (!await amendLastPrompt(sessionId, text, source, displayText)) {
		await handlePrompt(sessionId, text, undefined, source, displayText)
		return
	}
	await runGeneration(sessionId, '')
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
			if (cmd.delivery === 'queue') void queueRunner.enqueuePrompt(sessionId, cmd.text, cmd.source, cmd.displayText)
			else void dispatchPromptCommand(sessionId, cmd.text, cmd.source, cmd.displayText)
			break
		}
		case 'prompt-amend': {
			if (!sessionId) return
			void handlePromptAmendCommand(sessionId, cmd.text, cmd.source, cmd.displayText)
			break
		}
		case 'continue': {
			if (!sessionId) return
			void (async () => {
				if (agentLoop.isWorking(sessionId)) {
					agentLoop.abort(sessionId, '')
					await Bun.sleep(50)
				}
				void runGeneration(sessionId, '')
			})()
			break
		}
		case 'queue-next': {
			if (!sessionId) return
			if (agentLoop.isWorking(sessionId)) emitInfo(sessionId, 'Session is working')
			else void queueRunner.runNextQueuedPrompt(sessionId, false)
			break
		}
		case 'abort': {
			if (!cmd.sessionId) return
			const abortText = cmd.abortText ?? (promptQueue.load(cmd.sessionId).length > 0 ? '' : USER_PAUSED_TEXT)
			if (!agentLoop.abort(cmd.sessionId, abortText)) emitInfo(cmd.sessionId, 'No working turn to pause')
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
			void (async () => {
				try {
					const result = await whatSummary.run({ requesterSessionId: sessionId, target: cmd.target ?? '', openSessionIds: state.openSessionIds })
					if (result.renamed) broadcastSessions()
				} catch (err) {
					emitInfo(sessionId, `/what failed: ${errorMessage(err)}`, 'error', undefined, false)
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
			if (cmd.spawn.kind === 'subagent-autoclose' || cmd.spawn.kind === 'interactive') kind = cmd.spawn.kind
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
	recordTabClosed,
	spawnSession,
	startSpawnedSession,
	formatCommandError,
	handlePrompt,
	runCompact,
	handleCommand,
	// Used by sibling server modules (tabs, model-notices) at call time.
	broadcastSessions,
	publishContextEstimate,
}
