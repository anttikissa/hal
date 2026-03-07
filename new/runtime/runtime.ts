// Host runtime — tails commands, dispatches, manages sessions.

import { ensureBus, commands, events, updateState, getState } from '../ipc.ts'
import { createSession, loadMeta, listSessionIds } from '../session/session.ts'
import { appendMessages, loadApiMessages, readMessages, type UserMessage } from '../session/messages.ts'
import { runAgentLoop } from './agent-loop.ts'
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

export async function startRuntime(): Promise<Runtime> {
	await ensureBus()
	await events.trim(500)

	const sessions = new Map<string, SessionInfo>()
	const busySessionIds = new Set<string>()
	let activeSessionId: string | null = null
	let stopped = false

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

	// Tail commands
	const cmdTail = commands.tail()
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
		updateState(s => {
			s.sessions = [...sessions.keys()]
			s.activeSessionId = activeSessionId
			s.busySessionIds = [...busySessionIds]
		})
	}

	async function handleCommand(cmd: RuntimeCommand): Promise<void> {
		const sid = cmd.sessionId ?? activeSessionId
		if (!sid) return

		switch (cmd.type) {
			case 'prompt': {
				if (!cmd.text) return
				if (!sessions.has(sid)) return

				await emit({ type: 'prompt', sessionId: sid, text: cmd.text, source: cmd.source })

				const userMsg: UserMessage = { role: 'user', content: cmd.text, ts: new Date().toISOString() }
				await appendMessages(sid, [userMsg])

				const info = sessions.get(sid)!
				info.lastPrompt = cmd.text.split('\n')[0].slice(0, 120)

				const apiMessages = await loadApiMessages(sid)
				busySessionIds.add(sid)
				await publish('generating...')

				await runAgentLoop({
					sessionId: sid,
					model: info.model ?? getConfig().defaultModel,
					systemPrompt: 'You are a helpful assistant.',
					messages: apiMessages.filter((m: any) => m.role),
					onStatus: async (busy, activity) => {
						if (busy) busySessionIds.add(sid)
						else busySessionIds.delete(sid)
						await publish(activity)
					},
				})

				busySessionIds.delete(sid)
				await publish()
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
				if (!sessions.has(sid)) return
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
				await emit({ type: 'line', sessionId: sid, text: '[reset] conversation cleared', level: 'meta' })
				break
			}
			case 'topic': {
				const info = sessions.get(sid)
				if (info && cmd.text) {
					info.topic = cmd.text
					await publish()
				}
				break
			}
			case 'model': {
				const info = sessions.get(sid)
				if (info && cmd.text) {
					info.model = cmd.text
					await emit({ type: 'line', sessionId: sid, text: `[model] switched to ${cmd.text}`, level: 'meta' })
					await publish()
				}
				break
			}
		}
	}

	return {
		sessions,
		activeSessionId,
		busySessionIds,
		stop() { stopped = true; cmdTail.cancel() },
	}
}
