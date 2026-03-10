// Host runtime — tails commands, dispatches, manages sessions.

import { watch, type FSWatcher } from 'fs'
import { ensureBus, commands, events, updateState, getState } from '../ipc.ts'
import { createSession, loadMeta, listSessionIds, rotateLog, forkSession } from '../session/session.ts'
import { appendMessages, loadApiMessages, readMessages, writeToolResultEntry, detectInterruptedTools, parseUserContent, buildCompactionContext, type UserMessage } from '../session/messages.ts'
import { runAgentLoop } from './agent-loop.ts'
import { contextWindowForModel, estimateTokens, messageBytes } from './context.ts'
import { loadSystemPrompt } from './system-prompt.ts'
import { eventId, type RuntimeCommand, type RuntimeEvent, type SessionInfo } from '../protocol.ts'
import { getConfig } from '../config.ts'
import { HAL_DIR, LAUNCH_CWD } from '../state.ts'
import { resolveModel } from '../models.ts'

const GREETINGS = [
	'Hello! What shall we build today? Say **help** for help.',
	'Hey there! What are we working on? Say **help** for help.',
	'Hi! Ready when you are. Say **help** for help.',
	'Good to see you. What\'s the plan? Say **help** for help.',
]

function pick<T>(arr: T[]): T {
	return arr[Math.floor(Math.random() * arr.length)]
}

function timeAgo(iso: string): string {
	const ms = Date.now() - new Date(iso).getTime()
	if (ms < 0) return ''
	const mins = Math.floor(ms / 60_000)
	if (mins < 1) return 'just now'
	if (mins < 60) return `${mins}m ago`
	const hrs = Math.floor(mins / 60)
	if (hrs < 24) return `${hrs}h ago`
	const days = Math.floor(hrs / 24)
	return `${days}d ago`
}

export interface Runtime {
	sessions: Map<string, SessionInfo>
	activeSessionId: string | null
	busySessionIds: Set<string>
	stop(): void
}

// Helper: emit an event with auto-filled id + createdAt
function emit(fields: Omit<RuntimeEvent, 'id' | 'createdAt'>): Promise<void> {
	return events.append({ ...fields, id: eventId(), createdAt: new Date().toISOString() } as RuntimeEvent)
}

/** Emit IPC line event AND persist as info message. */
async function emitInfo(sessionId: string, text: string, level: string): Promise<void> {
	await appendMessages(sessionId, [{ type: 'info', text, level, ts: new Date().toISOString() }])
	await emit({ type: 'line', sessionId, text, level })
}

export async function startRuntime(): Promise<Runtime> {
	await ensureBus()
	const cmdOffset = await commands.offset()
	await events.trim(500)
	const sessions = new Map<string, SessionInfo>()
	const busySessionIds = new Set<string>()
	const abortControllers = new Map<string, AbortController>()
	let activeSessionId: string | null = null
	let stopped = false
	const pendingQuestions = new Map<string, { resolve: (answer: string) => void; question: string }>()
	const sessionContext = new Map<string, { used: number; max: number; estimated?: boolean }>()
	const pendingInterruptedTools = new Map<string, { name: string; id: string; ref: string }[]>()

	// Restore sessions from state.ason (preserves tab order across restarts)
	const prevState = getState()
	for (const id of prevState.sessions) {
		const meta = await loadMeta(id)
		if (meta) {
			sessions.set(meta.id, meta)
			if (meta.context) sessionContext.set(meta.id, meta.context)
			if (!activeSessionId) activeSessionId = meta.id
		}
	}
	// Prefer the previously active session
	if (prevState.activeSessionId && sessions.has(prevState.activeSessionId)) {
		activeSessionId = prevState.activeSessionId
	}
	// If nothing restored, create a fresh session with greeting
	let needsGreeting: string | null = null
	if (sessions.size === 0) {
		const info = await createSession()
		sessions.set(info.id, info)
		activeSessionId = info.id
		needsGreeting = info.id
	}

	// Publish initial state (must come before greeting so client has the tab)
	await publish()

	// Greet new session after publish so the client can receive the chunks
	if (needsGreeting) {
		await greetSession(needsGreeting)
	}

	for (const [id] of sessions) {
		await resumeInterruptedSession(id)
	}

	// Tail from offset captured at startup (no race window)
	const cmdTail = commands.tail(cmdOffset)
	;(async () => {
		for await (const cmd of cmdTail.items) {
			if (stopped) break
			await handleCommand(cmd)
		}
	})()

	// Watch SYSTEM.md + AGENTS.md for changes → notify active session
	const watchers: FSWatcher[] = []
	let watchDebounce: ReturnType<typeof setTimeout> | null = null
	const changedNames = new Set<string>()
	const onPromptFileChange = (name: string) => {
		changedNames.add(name)
		if (watchDebounce) clearTimeout(watchDebounce)
		watchDebounce = setTimeout(async () => {
			const label = [...changedNames].join(', ')
			changedNames.clear()
			if (activeSessionId) await emitInfo(activeSessionId, `[system] reloaded ${label} (file changed)`, 'meta')
		}, 150)
	}
	for (const [path, name] of [[`${HAL_DIR}/SYSTEM.md`, 'SYSTEM.md'], [`${LAUNCH_CWD}/AGENTS.md`, 'AGENTS.md']] as const) {
		try { watchers.push(watch(path, { persistent: false }, () => onPromptFileChange(name))) } catch {}
	}

	async function greetSession(sessionId: string): Promise<void> {
		const text = pick(GREETINGS)
		await appendMessages(sessionId, [{ role: 'assistant', text, ts: new Date().toISOString() }])
	}

	function flushSessionMeta(): void {
		for (const info of sessions.values()) {
			;(info as SessionInfo & { save?: () => void }).save?.()
		}
	}

	async function publish(activity?: string): Promise<void> {
		const contexts: Record<string, { used: number; max: number }> = {}
		for (const [id, ctx] of sessionContext) contexts[id] = ctx
		await emit({
			type: 'status', sessionId: null,
			busySessionIds: [...busySessionIds], pausedSessionIds: [],
			activeSessionId, busy: busySessionIds.size > 0,
			queueLength: 0, activity,
			contexts: Object.keys(contexts).length > 0 ? contexts : undefined,
		})
		await emit({
			type: 'sessions',
			activeSessionId, sessions: [...sessions.values()],
		})
		flushSessionMeta()
		updateState(s => {
			s.sessions = [...sessions.keys()]
			s.activeSessionId = activeSessionId
			s.busySessionIds = [...busySessionIds]
		})
	}

	function hasPendingUserTurn(messages: any[]): boolean {
		if (messages.length === 0) return false
		return messages[messages.length - 1]?.role === 'user'
	}

	async function askUser(sessionId: string, question: string): Promise<string> {
		const questionId = eventId()
		return new Promise(resolve => {
			pendingQuestions.set(sessionId, { resolve, question })
			void emit({ type: 'question', sessionId, questionId, text: question })
		})
	}

	async function startGeneration(
		sid: string,
		info: SessionInfo,
		apiMessages: any[],
		activity = 'generating...',
	): Promise<void> {
		const ac = new AbortController()
		abortControllers.set(sid, ac)
		busySessionIds.add(sid)
		await publish(activity)
		const sysPrompt = loadSystemPrompt({ model: info.model ?? getConfig().defaultModel, sessionDir: sid })
		runAgentLoop({
			sessionId: sid,
			model: info.model ?? getConfig().defaultModel,
			systemPrompt: sysPrompt.text,
			messages: apiMessages,
			onStatus: async (busy, nextActivity, context) => {
				if (busy) busySessionIds.add(sid)
				else busySessionIds.delete(sid)
				if (context) {
					const existing = sessionContext.get(sid)
					if (!context.estimated || !existing || existing.estimated) {
						sessionContext.set(sid, context)
						info.context = { used: context.used, max: context.max }
					}
					if (!context.estimated) {
						const pct = context.used / context.max
						if (pct >= 0.65 && pct < 0.70) {
							await emitInfo(sid, `[context] ${Math.round(pct * 100)}% used — will autocompact at 70%`, 'warn')
						}
					}
				}
				await publish(nextActivity)
			},
			askUser: (question) => askUser(sid, question),
			signal: ac.signal,
		}).finally(async () => {
			abortControllers.delete(sid)
			busySessionIds.delete(sid)
			await publish()
		})
	}



	// ── Resume detection ──

	async function resumeInterruptedSession(sessionId: string): Promise<void> {
		const messages = await readMessages(sessionId)
		const interrupted = detectInterruptedTools(messages)
		if (interrupted.length > 0) {
			pendingInterruptedTools.set(sessionId, interrupted)
			const toolList = interrupted.map(t => t.name).join(', ')
			await emit({
				type: 'line',
				sessionId,
				text: `[resume] interrupted during tools (${toolList}). Use /respond skip, then /continue`,
				level: 'warn',
			})
			return
		}

		const apiMessages = await loadApiMessages(sessionId)
		if (!hasPendingUserTurn(apiMessages)) return
		await emit({
			type: 'line',
			sessionId,
			text: '[resume] Type /continue to continue the interrupted response',
			level: 'meta',
		})
	}

	async function handleCommand(cmd: RuntimeCommand): Promise<void> {
		const sid = cmd.sessionId ?? activeSessionId
		const warn = (text: string) => emit({ type: 'line', sessionId: sid, text, level: 'warn' })
		const error = (text: string) => emit({ type: 'line', sessionId: sid, text, level: 'error' })
		if (!sid) { await error('No active session'); return }

		switch (cmd.type) {
			case 'pause': {
				const ac = abortControllers.get(sid)
				if (ac) ac.abort()
				else await warn('Session is not busy')
				break
			}
			case 'prompt': {
				if (!cmd.text) { await warn('Empty prompt'); return }
				if (!sessions.has(sid)) { await error(`Session ${sid} not found`); return }
				if (busySessionIds.has(sid)) { await warn('Session is busy'); return }

				// Auto-resolve interrupted tools before building API messages
				const interrupted = pendingInterruptedTools.get(sid) ?? detectInterruptedTools(await readMessages(sid))
				if (interrupted.length > 0) {
					const toolRefMap = new Map(interrupted.map(t => [t.id, t.ref]))
					for (const t of interrupted) {
						const entry = await writeToolResultEntry(sid, t.id, '[interrupted — skipped]', toolRefMap)
						await appendMessages(sid, [entry])
					}
					pendingInterruptedTools.delete(sid)
				}

				await emit({ type: 'prompt', sessionId: sid, text: cmd.text, source: cmd.source })

				const { apiContent, logContent } = await parseUserContent(sid, cmd.text)
				const userMsg: UserMessage = { role: 'user', content: logContent, ts: new Date().toISOString() }
				await appendMessages(sid, [userMsg])

				const info = sessions.get(sid)!
				info.lastPrompt = cmd.text.split('\n')[0].slice(0, 120)

				let apiMessages = await loadApiMessages(sid)

				// Autocompact at 70% context usage
				const modelId = (info.model ?? getConfig().defaultModel).split('/').pop()!
				const ctxMax = contextWindowForModel(modelId)
				let totalBytes = 0
				for (const m of apiMessages) totalBytes += messageBytes(m)
				const usedPct = estimateTokens(totalBytes, modelId) / ctxMax
				if (usedPct >= 0.70) {
					const msgs = await readMessages(sid)
					const userMsgs = msgs.filter(m => m.role === 'user')
					const context = buildCompactionContext(sid, msgs)
					await appendMessages(sid, [
						{ type: 'handoff', ts: new Date().toISOString() },
						{ role: 'user', content: context, ts: new Date().toISOString() } as UserMessage,
						{ role: 'user', content: logContent, ts: new Date().toISOString() } as UserMessage,
					])
					apiMessages = await loadApiMessages(sid)
					const newBytes = apiMessages.reduce((s, m) => s + messageBytes(m), 0)
					const newPct = estimateTokens(newBytes, modelId) / ctxMax
					await emitInfo(sid, `[autocompact] ${Math.round(usedPct * 100)}% → ${Math.round(newPct * 100)}% (${userMsgs.length} prompts summarized)`, 'meta')
				}

				// Replace the last user message's content with parsed apiContent (includes base64 images)
				if (apiMessages.length > 0 && apiMessages[apiMessages.length - 1].role === 'user') {
					apiMessages[apiMessages.length - 1].content = apiContent
				}
				await startGeneration(sid, info, apiMessages)
				break
			}
			case 'open': {
				const resumeId = cmd.text?.trim()
				let info: SessionInfo
				if (resumeId) {
					info = loadMeta(resumeId)
					if (!info) {
						emitInfo(sid, `[resume] session ${resumeId} not found`)
						break
					}
				} else {
					info = await createSession()
				}
				sessions.set(info.id, info)
				activeSessionId = info.id
				await publish()
				if (!resumeId) await greetSession(info.id)
				break
			}
			case 'fork': {
				const childId = await forkSession(sid)
				const childMeta = loadMeta(childId)
				if (!childMeta) { await error('Failed to create forked session'); break }
				sessions.set(childId, childMeta)
				activeSessionId = childId
				await appendMessages(childId, [
					{ role: 'user', content: `[system] Forked from session ${sid}.`, ts: new Date().toISOString() } as UserMessage,
				])
				await emitInfo(sid, `[fork] forked ${sid} -> ${childId}`, 'meta')
				await emitInfo(childId, `[fork] forked ${sid} -> ${childId}`, 'meta')
				await publish()
				break
			}
			case 'close': {
				if (!sessions.has(sid)) { await warn(`Session ${sid} not open`); return }
				const closing = sessions.get(sid)!
				closing.closedAt = new Date().toISOString()
				;(closing as SessionInfo & { save?: () => void }).save?.()
				sessions.delete(sid)
				if (activeSessionId === sid) {
					activeSessionId = sessions.keys().next().value ?? null
				}
				if (sessions.size === 0) {
					const info = await createSession()
					sessions.set(info.id, info)
					activeSessionId = info.id
				}
				await publish()
				break
			}
			case 'reset': {
				const resetMsgs = await readMessages(sid)
				const oldLog = sessions.get(sid)?.log ?? 'messages.asonl'
				const newLog = await rotateLog(sid)
				const info = sessions.get(sid)
				if (info) info.log = newLog
				// Preserve fork lineage across reset
				const forkEntry = (resetMsgs[0] as any)?.type === 'forked_from' ? [resetMsgs[0]] : []
				await appendMessages(sid, [
					...forkEntry,
					{ role: 'user', content: `[system] Session was reset. Previous conversation: ${oldLog}`, ts: new Date().toISOString() } as UserMessage,
				])
				await emitInfo(sid, '[reset] conversation cleared', 'meta')
				break
			}
			case 'compact': {
				if (busySessionIds.has(sid)) { await warn('Session is busy'); break }
				const msgs = await readMessages(sid)
				const userMsgs = msgs.filter((m: any) => m.role === 'user')
				if (userMsgs.length === 0) { await warn('[compact] nothing to compact'); break }
				const context = buildCompactionContext(sid, msgs)
				const oldLog = sessions.get(sid)?.log ?? 'messages.asonl'
				const newLog = await rotateLog(sid)
				const info = sessions.get(sid)
				if (info) info.log = newLog
				// Preserve fork lineage across compaction
				const forkEntry = (msgs[0] as any)?.type === 'forked_from' ? [msgs[0]] : []
				await appendMessages(sid, [
					...forkEntry,
					{ role: 'user', content: `[system] Session was manually compacted. Previous conversation: ${oldLog}`, ts: new Date().toISOString() } as UserMessage,
					{ role: 'user', content: context, ts: new Date().toISOString() } as UserMessage,
				])
				await emitInfo(sid, `[compact] context compacted (${userMsgs.length} user messages summarized)`, 'meta')
				break
			}
			case 'topic': {
				if (!cmd.text) { await warn('/topic <name>'); return }
				const info = sessions.get(sid)
				if (!info) { await error(`Session ${sid} not found`); return }
				info.topic = cmd.text
				await publish()
				break
			}
			case 'model': {
				if (!cmd.text) { await warn('/model <provider/model-id>'); return }
				const info = sessions.get(sid)
				if (!info) { await error(`Session ${sid} not found`); return }
				info.model = resolveModel(cmd.text)
				await emitInfo(sid, `[model] ${info.model}`, 'meta')
				await publish()
				break
			}
			case 'continue': {
				if (busySessionIds.has(sid)) { await warn('Session is busy'); break }
				const info = sessions.get(sid)
				if (!info) { await error(`Session ${sid} not found`); break }
				const interrupted = pendingInterruptedTools.get(sid) ?? []
				if (interrupted.length > 0) {
					await warn('Interrupted tools are present. Use /respond skip before /continue')
					break
				}
				const apiMessages = await loadApiMessages(sid)
				if (!hasPendingUserTurn(apiMessages)) {
					await warn('No interrupted user turn to continue')
					break
				}
				await emitInfo(sid, '[resume] continuing interrupted response', 'meta')
				await startGeneration(sid, info, apiMessages, 'continuing...')
				break
			}
			case 'resume': {
				const id = cmd.text?.trim()
				if (!id) {
					const all = await listSessionIds()
					const closed = all.filter(s => !sessions.has(s))
					if (closed.length === 0) {
						await emit({ type: 'line', sessionId: sid, text: 'No closed sessions', level: 'info' })
						break
					}
					const items: { id: string; topic?: string; lastPrompt?: string; sortTs?: string; msgCount: number }[] = []
					for (const cid of closed) {
						const m = loadMeta(cid)
						const msgs = await readMessages(cid)
						const msgCount = msgs.filter((e: any) => e.role).length
						if (m) items.push({ id: cid, topic: m.topic, lastPrompt: m.lastPrompt, sortTs: m.closedAt ?? m.updatedAt, msgCount })
						else items.push({ id: cid, msgCount })
					}
					items.sort((a, b) => (b.sortTs ?? '').localeCompare(a.sortTs ?? ''))
					const lines = items.slice(0, 20).map(s => {
						const label = s.topic || s.lastPrompt || ''
						const age = s.sortTs ? timeAgo(s.sortTs) : ''
						const count = s.msgCount > 0 ? `${s.msgCount} msgs` : ''
						const parts = [s.id.padEnd(8)]
						if (label) parts.push(label.slice(0, 50))
						if (count) parts.push(count)
						if (age) parts.push(age)
						return parts.join('  ')
					})
					const text = ['[resume] /resume <id> to reopen', ...lines].join('\n')
					await emit({ type: 'line', sessionId: sid, text, level: 'info' })
					break
				}
				if (sessions.has(id)) { await warn(`Session ${id} is already open`); break }
				const meta = await loadMeta(id)
				if (!meta) { await error(`Session ${id} not found`); break }
				sessions.set(id, meta)
				activeSessionId = id
				await publish()
				break
			}
			case 'respond': {
				const pending = pendingQuestions.get(sid)
				if (pending) {
					pendingQuestions.delete(sid)
					const answer = cmd.text ?? ''
					await emit({ type: 'answer', sessionId: sid, question: pending.question, text: answer })
					pending.resolve(answer)
					break
				}
				const answer = (cmd.text ?? '').trim().toLowerCase()
				if (answer && answer !== 'skip') {
					await warn('Reply with "skip" or leave blank to continue without rerunning interrupted tools')
					break
				}
				const interrupted = pendingInterruptedTools.get(sid) ?? []
				if (interrupted.length > 0) {
					const toolRefMap = new Map(interrupted.map(t => [t.id, t.ref]))
					for (const t of interrupted) {
						const entry = await writeToolResultEntry(sid, t.id, '[interrupted — skipped by user]', toolRefMap)
						await appendMessages(sid, [entry])
					}
					await emitInfo(sid, `[resume] ${interrupted.length} interrupted tool(s) marked skipped`, 'warn')
				}
				pendingInterruptedTools.delete(sid)
				break
			}
			default:
				await error(`Unknown command: /${cmd.type}`)
		}
	}

	return {
		sessions,
		get activeSessionId() { return activeSessionId },
		busySessionIds,
		stop() { stopped = true; cmdTail.cancel(); watchers.forEach(w => w.close()) },
	}
}
