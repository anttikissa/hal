// Server runtime — watches commands and dispatches to agent loop.
//
// Broadcasts session list via IPC. Clients load history directly from disk.

import { ipc } from '../ipc.ts'
import { protocol } from '../protocol.ts'
import type { Command, SpawnCommandData } from '../protocol.ts'
import { models } from '../models.ts'
import { sessions as sessionStore, type SessionMeta } from './sessions.ts'
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

let activeSessions: string[] = []
let activeRuntimePid: number | null = null
let stopPromptWatch: (() => void) | null = null

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
	return `${sessionTitle(meta)} (${meta.id})`
}

function activeMetas(): SessionMeta[] {
	return activeSessions
		.map((sessionId) => sessionStore.loadSessionMeta(sessionId))
		.filter((meta): meta is SessionMeta => !!meta)
}

function insertSessionAfter(sessionId: string, afterId?: string): void {
	if (!afterId) {
		activeSessions.push(sessionId)
		return
	}
	const idx = activeSessions.findIndex((id) => id === afterId)
	if (idx < 0) {
		activeSessions.push(sessionId)
		return
	}
	activeSessions.splice(idx + 1, 0, sessionId)
}

function moveSessionToIndex(sessionId: string, targetIndex: number): boolean {
	const fromIndex = activeSessions.findIndex((id) => id === sessionId)
	if (fromIndex < 0) return false
	const clampedIndex = Math.max(0, Math.min(activeSessions.length - 1, targetIndex))
	if (fromIndex === clampedIndex) return false
	const [id] = activeSessions.splice(fromIndex, 1)
	if (!id) return false
	activeSessions.splice(clampedIndex, 0, id)
	return true
}

function syncSharedState(): void {
	const openMetas = activeMetas()
	const openIds = new Set(openMetas.map((meta) => meta.id))
	ipc.updateState((state) => {
		state.sessions = openMetas.map((meta) => meta.id)
		state.openSessions = openMetas.map(sessionStore.sessionOpenInfo)
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

function emitInfo(sessionId: string, text: string, level: 'info' | 'error' = 'info'): void {
	ipc.appendEvent({
		id: protocol.eventId(),
		type: 'info',
		text,
		level,
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

function shouldAutoContinue(entries: Array<{ type: string; text?: string; ts?: string }>, now = Date.now()): boolean {
	let lastType: string | undefined
	let lastTs: string | undefined
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!
		if (entry.type === 'info' && (entry.text === USER_PAUSED_TEXT || entry.text === TAB_CLOSED_TEXT)) return false
		if (!lastType && (entry.type === 'user' || entry.type === 'tool_result' || entry.type === 'assistant')) {
			lastType = entry.type
			lastTs = entry.ts
		}
		if (lastType) break
	}
	if (lastType !== 'user' && lastType !== 'tool_result') return false
	return !lastTs || (now - new Date(lastTs).getTime()) <= 30_000
}

function recordSessionInfo(sessionId: string, text: string, ts: string): void {
	sessionStore.appendHistorySync(sessionId, [{ type: 'info', text, ts }])
}

function createSessionTab(opts: { openerId?: string; afterId?: string; sourceId?: string; sessionId?: string }): SessionMeta {
	const sessionId = opts.sessionId ?? sessionIds.reserve()
	const meta = opts.sourceId
		? sessionStore.forkSession(opts.sourceId, sessionId)
		: sessionStore.createSession(sessionId, {
			id: sessionId,
			workingDir: process.cwd(),
			createdAt: new Date().toISOString(),
			name: undefined,
			topic: undefined,
		})
	insertSessionAfter(sessionId, opts.sourceId ?? opts.afterId)
	const related = sessionStore.loadSessionMeta(opts.sourceId ?? opts.openerId ?? '')
	const text = opts.sourceId
		? related ? `User forked ${sessionLabel(related)} into ${sessionLabel(meta)}.` : ''
		: related
			? `User opened a new tab: ${sessionLabel(meta)}. Opened from ${sessionLabel(related)}.`
			: `User opened a new tab: ${sessionLabel(meta)}.`
	if (text) recordSessionInfo(sessionId, text, meta.createdAt)
	return meta
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

function queuePromptCommand(sessionId: string, text: string, source?: string): void {
	ipc.appendCommand({ type: 'prompt', sessionId, text, source, createdAt: new Date().toISOString() })
}

function spawnSession(parent: SessionMeta, spec: SpawnSpec): SessionMeta {
	const mode = spec.mode === 'fresh' ? 'fresh' : 'fork'
	const child = createSessionTab(
		mode === 'fork'
			? { sourceId: parent.id, sessionId: spec.childSessionId }
			: { afterId: parent.id, sessionId: spec.childSessionId },
	)
	const workingDir = spec.cwd || (mode === 'fork' ? child.workingDir : parent.workingDir) || process.cwd()
	const model = spec.model || (mode === 'fork' ? child.model : parent.model)
	const name = spec.title || child.name
	sessionStore.updateMeta(child.id, {
		workingDir,
		model,
		name,
		topic: spec.title || child.name,
		closeWhenDone: !!spec.closeWhenDone,
	})
	if (spec.closeWhenDone) {
		recordSessionInfo(child.id, 'This subagent will close itself after sending a handoff.', new Date().toISOString())
	}
	return sessionStore.loadSessionMeta(child.id) ?? child
}

async function startSpawnedSession(parent: SessionMeta, child: SessionMeta, spec: SpawnSpec): Promise<void> {
	await dispatchPromptCommand(child.id, buildSpawnPrompt(parent.id, spec.task, !!spec.closeWhenDone), parent.id)
}
function restartPromptWatch(): void {
	stopPromptWatch?.()
	stopPromptWatch = context.watchPromptFiles(
		activeMetas().map((meta) => ({ sessionId: meta.id, cwd: meta.workingDir ?? process.cwd() })),
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
		sessions: activeMetas().map((item) => ({ id: item.id, name: sessionTitle(item) })),
	}
}

async function handlePrompt(sessionId: string, text: string, label?: 'steering', source?: string): Promise<void> {
	if (!ipc.ownsHostLock()) return
	const meta = sessionStore.loadSessionMeta(sessionId)
	if (!meta) return
	const sessionState = buildSessionState(meta)
	const prevName = sessionState.name
	const prevModel = sessionState.model
	const prevCwd = sessionState.cwd
	const cmdResult = await commands.executeCommand(text, sessionState)
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
		if (cmdResult.output) emitInfo(sessionId, cmdResult.output)
		if (cmdResult.error) emitInfo(sessionId, cmdResult.error, 'error')
		if (label === 'steering' && !cmdResult.error && /^\/model\b/.test(text.trimStart())) void runGeneration(sessionId, '', source)
		return
	}
	ipc.appendEvent({
		type: 'prompt',
		text,
		label,
		source,
		sessionId,
		createdAt: new Date().toISOString(),
	})
	await runGeneration(sessionId, text, source)
}

async function dispatchPromptCommand(sessionId: string, text: string, source?: string): Promise<void> {
	const steering = agentLoop.isActive(sessionId)
	if (steering) {
		agentLoop.abort(sessionId)
		await Bun.sleep(50)
	}
	await handlePrompt(sessionId, text, steering ? 'steering' : undefined, source)
}

function closeSession(sessionId: string, openReplacement = false): void {
	sessionStore.updateMeta(sessionId, { closedAt: new Date().toISOString(), closeWhenDone: false })
	sessionStore.deactivateSession(sessionId)
	activeSessions = activeSessions.filter((id) => id !== sessionId)
	if (openReplacement && activeSessions.length === 0) createSessionTab({})
	broadcastSessions()
}

async function runGeneration(sessionId: string, text: string, source?: string): Promise<void> {
	if (!ipc.ownsHostLock()) return
	const meta = sessionStore.loadSessionMeta(sessionId)
	if (!meta) return
	const cwd = meta.workingDir ?? process.cwd()
	const model = meta.model ?? models.defaultModel()
	const promptResult = context.buildSystemPrompt({ model, cwd, sessionId })
	if (text) {
		const resolved = await attachments.resolve(sessionId, text)
		sessionStore.appendHistory(sessionId, [{
			type: 'user',
			parts: resolved.logParts,
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
	}
}

function publishContextEstimate(sessionId: string): void {
	const meta = sessionStore.loadSessionMeta(sessionId)
	if (!meta) return
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
	publishContextEstimate(sessionId)
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
	publishContextEstimate(sessionId)
	emitInfo(sessionId, `Context compacted (${userMsgs.length} user messages summarized, now writing to ${newLog})`)
}

function handleCommand(cmd: Command): void {
	const sessionId = cmd.sessionId ?? activeSessions[0]
	switch (cmd.type) {
		case 'prompt': {
			if (!sessionId) return
			void dispatchPromptCommand(sessionId, cmd.text, cmd.source)
			break
		}
		case 'continue': {
			if (!sessionId || agentLoop.isActive(sessionId)) return
			void runGeneration(sessionId, '')
			break
		}
		case 'abort': {
			if (!cmd.sessionId) return
			if (!agentLoop.abort(cmd.sessionId)) emitInfo(cmd.sessionId, 'No active generation to abort')
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
		case 'open': {
			if ('forkSessionId' in cmd) {
				const child = createSessionTab({ sourceId: cmd.forkSessionId })
				const msg = `forked ${cmd.forkSessionId} → ${child.id}`
				emitInfo(cmd.forkSessionId, msg)
				emitInfo(child.id, msg)
			} else if ('afterSessionId' in cmd) {
				createSessionTab({ openerId: sessionId, afterId: cmd.afterSessionId })
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
		case 'resume': {
			const selector = (cmd.selector ?? '').trim()
			const resumeId = sessionStore.resolveResumeTarget(sessionStore.loadAllSessionMetas(), new Set(activeSessions), selector)
			if (!resumeId) {
				emitInfo(
					sessionId ?? activeSessions[0] ?? '',
					selector ? 'No matching closed session.' : 'No closed sessions.',
					selector ? 'error' : 'info',
				)
				break
			}
			const resumed = sessionStore.activateSession(resumeId)
			if (!resumed) {
				emitInfo(sessionId ?? activeSessions[0] ?? resumeId, `Session ${resumeId} not found`, 'error')
				break
			}
			activeSessions.push(resumeId)
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

function startRuntime(signal: AbortSignal): void {
	activeRuntimePid = process.pid
	activeSessions = []
	stopPromptWatch?.()
	stopPromptWatch = null
	sessionStore.deactivateAllSessions()
	const metas = sessionStore.loadSessionMetas()
	activeSessions = metas.map((meta) => meta.id)
	if (activeSessions.length === 0) {
		createSessionTab({})
		if (!signal.aborted && activeRuntimePid === process.pid) broadcastSessions()
	}
	restartPromptWatch()
	signal.addEventListener('abort', () => {
		stopPromptWatch?.()
		stopPromptWatch = null
		const ts = new Date().toISOString()
		for (const sessionId of activeSessions) {
			if (!agentLoop.isActive(sessionId)) continue
			sessionStore.appendHistorySync(sessionId, [{ type: 'info', text: RESTARTED_TEXT, ts }])
			agentLoop.abort(sessionId, '')
		}
	}, { once: true })
	ipc.updateState((state) => {
		state.busy = {}
		state.activity = {}
	})
	if (metas.length > 0) syncSharedState()
	models.refreshModels().catch((err) => {
		console.error(`[models] refresh failed: ${errorMessage(err)}`)
	})
	openaiUsage.start(signal)
	if (metas.length > 0) {
		setTimeout(() => {
			if (signal.aborted || activeRuntimePid !== process.pid) return
			broadcastSessions()
		}, 0)
	}
	void (async () => {
		for (const sessionId of activeSessions) {
			if (signal.aborted || activeRuntimePid !== process.pid || !ipc.ownsHostLock()) return
			const entries = sessionStore.loadAllHistory(sessionId)
			if (entries.length === 0) continue
			const interrupted = sessionStore.detectInterruptedTools(entries)
			if (interrupted.length > 0) {
				emitInfo(sessionId, `Resolving ${interrupted.length} interrupted tool(s): ${interrupted.map((tool) => tool.name).join(', ')}`)
				for (const tool of interrupted) {
					sessionStore.appendHistory(sessionId, [{
						type: 'tool_result',
						toolId: tool.id,
						output: '[interrupted]',
						ts: new Date().toISOString(),
					}])
				}
			}
			const allEntries = interrupted.length > 0 ? sessionStore.loadAllHistory(sessionId) : entries
			if (shouldAutoContinue(allEntries)) {
				emitInfo(sessionId, 'Continuing...')
				void runGeneration(sessionId, '')
			}
		}
	})()
	void (async () => {
		for await (const cmd of ipc.tailCommands(signal)) {
			if (signal.aborted || activeRuntimePid !== process.pid) break
			if (!ipc.ownsHostLock()) break
			const hasLiveSession = !cmd.sessionId || activeSessions.includes(cmd.sessionId)
			if (!hasLiveSession && cmd.type !== 'open' && cmd.type !== 'resume') continue
			try {
				handleCommand(cmd)
			} catch (err: any) {
				const sid = cmd.sessionId ?? activeSessions[0]
				if (sid) emitInfo(sid, `Command error: ${err?.message ?? String(err)}`, 'error')
			}
		}
	})()
	void import('../mcp/client.ts')
		.then(({ mcp }) => {
			mcp.initServers().catch((err: any) => {
				console.error(`[mcp] init failed: ${err?.message ?? String(err)}`)
			})
			signal.addEventListener('abort', () => {
				void mcp.shutdown()
			}, { once: true })
		})
		.catch((err) => {
			console.error(`[mcp] failed to load client module: ${errorMessage(err)}`)
		})
	void import('../runtime/inbox.ts')
		.then(({ inbox }) => {
			inbox.startWatching(signal, (sessionId, text, source) => {
				if (!activeSessions.includes(sessionId)) return
				queuePromptCommand(sessionId, text, source)
			})
		})
		.catch((err) => {
			console.error(`[inbox] failed to load module: ${errorMessage(err)}`)
		})
}

export const runtime = {
	startRuntime,
	pickMostRecentlyClosedSessionId: sessionStore.pickMostRecentlyClosedSessionId,
	resolveResumeTarget: sessionStore.resolveResumeTarget,
	shouldAutoContinue,
	shouldCloseSessionAfterGeneration,
	recordTabClosed,
	spawnSession,
	startSpawnedSession,
}
