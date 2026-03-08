// Host runtime — tails commands, dispatches, manages sessions.

import { ensureBus, commands, events, updateState, getState } from '../ipc.ts'
import { createSession, loadMeta, listSessionIds } from '../session/session.ts'
import { appendMessages, loadApiMessages, readMessages, writeToolResultEntry, detectInterruptedTools, parseUserContent, type UserMessage } from '../session/messages.ts'
import { runAgentLoop } from './agent-loop.ts'
import { loadSystemPrompt } from './system-prompt.ts'
import { eventId, type RuntimeCommand, type RuntimeEvent, type SessionInfo } from '../protocol.ts'
import { getConfig } from '../config.ts'

const GREETINGS = [
	'Hello! What shall we build today? Say **help** for help.',
	'Hey there! What are we working on? Say **help** for help.',
	'Hi! Ready when you are. Say **help** for help.',
	'Good to see you. What\'s the plan? Say **help** for help.',
]

function pick<T>(arr: T[]): T {
	return arr[Math.floor(Math.random() * arr.length)]
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
	const pendingQuestions = new Map<string, (answer: string) => void>()
	const pendingInterruptedTools = new Map<string, { name: string; id: string; ref: string }[]>()

	// Restore sessions from state.ason (preserves tab order across restarts)
	const prevState = getState()
	for (const id of prevState.sessions) {
		const meta = await loadMeta(id)
		if (meta) {
			sessions.set(meta.id, meta)
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

	async function greetSession(sessionId: string): Promise<void> {
		const text = pick(GREETINGS)
		await appendMessages(sessionId, [{ role: 'assistant', text, ts: new Date().toISOString() }])
		await emit({ type: 'chunk', sessionId, text, channel: 'assistant' })
		await emit({ type: 'command', sessionId, commandId: '', phase: 'done' })
	}

	function flushSessionMeta(): void {
		for (const info of sessions.values()) {
			;(info as SessionInfo & { save?: () => void }).save?.()
		}
	}

	async function publish(activity?: string): Promise<void> {
		await emit({
			type: 'status', sessionId: null,
			busySessionIds: [...busySessionIds], pausedSessionIds: [],
			activeSessionId, busy: busySessionIds.size > 0,
			queueLength: 0, activity,
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
			pendingQuestions.set(sessionId, resolve)
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
		runAgentLoop({
			sessionId: sid,
			model: info.model ?? getConfig().defaultModel,
			systemPrompt: loadSystemPrompt({ model: info.model ?? getConfig().defaultModel, sessionDir: sid }),
			messages: apiMessages,
			onStatus: async (busy, nextActivity) => {
				if (busy) busySessionIds.add(sid)
				else busySessionIds.delete(sid)
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

				const apiMessages = await loadApiMessages(sid)
				// Replace the last user message's content with parsed apiContent (includes base64 images)
				if (apiMessages.length > 0 && apiMessages[apiMessages.length - 1].role === 'user') {
					apiMessages[apiMessages.length - 1].content = apiContent
				}
				await startGeneration(sid, info, apiMessages)
				break
			}
			case 'open': {
				const info = await createSession()
				sessions.set(info.id, info)
				activeSessionId = info.id
				await publish()
				await greetSession(info.id)
				break
			}
			case 'close': {
				if (!sessions.has(sid)) { await warn(`Session ${sid} not open`); return }
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
				await appendMessages(sid, [{ type: 'reset', ts: new Date().toISOString() }])
				await emitInfo(sid, '[reset] conversation cleared', 'meta')
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
				info.model = cmd.text
				await emitInfo(sid, `[model] ${cmd.text}`, 'meta')
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
					const text = closed.length ? `Sessions: ${closed.join(', ')}` : 'No closed sessions'
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
				const resolve = pendingQuestions.get(sid)
				if (resolve) {
					pendingQuestions.delete(sid)
					resolve(cmd.text ?? '')
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
		activeSessionId,
		busySessionIds,
		stop() { stopped = true; cmdTail.cancel() },
	}
}
