// Host runtime — tails commands, dispatches, manages sessions.

import { ensureBus, tailCommandsFrom, appendEvent, updateState, writeState, trimEvents } from '../ipc.ts'
import { createSession, loadMeta, saveMeta } from '../session/session.ts'
import { appendMessages, loadApiMessages, readMessages, type UserMessage } from '../session/messages.ts'
import { runAgentLoop } from './agent-loop.ts'
import { eventId, defaultState, type RuntimeCommand, type RuntimeEvent, type SessionInfo } from '../protocol.ts'
import { getConfig } from '../config.ts'

export interface Runtime {
	sessions: Map<string, SessionInfo>
	activeSessionId: string | null
	busySessionIds: Set<string>
	stop(): void
}

export async function startRuntime(): Promise<Runtime> {
	await ensureBus()
	await trimEvents()

	const sessions = new Map<string, SessionInfo>()
	const busySessionIds = new Set<string>()
	let activeSessionId: string | null = null
	let stopped = false

	// Load or create initial session
	const config = getConfig()
	if (config.activeSessionId) {
		const meta = await loadMeta(config.activeSessionId)
		if (meta) {
			sessions.set(meta.id, meta)
			activeSessionId = meta.id
		}
	}
	if (!activeSessionId) {
		const info = await createSession()
		sessions.set(info.id, info)
		activeSessionId = info.id
	}

	// Publish initial state
	await publishStatus()
	await publishSessions()

	// Tail commands
	const { commands } = await tailCommandsFrom()
	;(async () => {
		for await (const cmd of commands) {
			if (stopped) break
			await handleCommand(cmd)
		}
	})()

	async function publishStatus(activity?: string): Promise<void> {
		await appendEvent({
			id: eventId(),
			type: 'status',
			sessionId: null,
			busySessionIds: [...busySessionIds],
			pausedSessionIds: [],
			activeSessionId,
			busy: busySessionIds.size > 0,
			queueLength: 0,
			activity,
			createdAt: new Date().toISOString(),
		})
		await updateState(s => {
			s.sessions = [...sessions.keys()]
			s.activeSessionId = activeSessionId
			s.busySessionIds = [...busySessionIds]
		})
	}

	async function publishSessions(): Promise<void> {
		await appendEvent({
			id: eventId(),
			type: 'sessions',
			activeSessionId,
			sessions: [...sessions.values()],
			createdAt: new Date().toISOString(),
		})
	}

	async function handleCommand(cmd: RuntimeCommand): Promise<void> {
		const sid = cmd.sessionId ?? activeSessionId
		if (!sid) return

		switch (cmd.type) {
			case 'prompt': {
				if (!cmd.text) return
				if (!sessions.has(sid)) return

				// Acknowledge
				await appendEvent({
					id: eventId(), type: 'prompt', sessionId: sid,
					text: cmd.text, source: cmd.source, createdAt: new Date().toISOString(),
				})

				// Persist user message
				const userMsg: UserMessage = { role: 'user', content: cmd.text, ts: new Date().toISOString() }
				await appendMessages(sid, [userMsg])

				// Update session info
				const info = sessions.get(sid)!
				info.lastPrompt = cmd.text.split('\n')[0].slice(0, 120)
				await saveMeta(info)

				// Load full history and run
				const apiMessages = await loadApiMessages(sid)
				busySessionIds.add(sid)
				await publishStatus('generating...')

				await runAgentLoop({
					sessionId: sid,
					model: info.model ?? getConfig().defaultModel,
					systemPrompt: 'You are a helpful assistant.',
					messages: apiMessages.filter((m: any) => m.role),
					onStatus: async (busy, activity) => {
						if (busy) busySessionIds.add(sid)
						else busySessionIds.delete(sid)
						await publishStatus(activity)
					},
				})

				busySessionIds.delete(sid)
				await publishStatus()
				break
			}
			case 'open': {
				const info = await createSession()
				sessions.set(info.id, info)
				activeSessionId = info.id
				await publishSessions()
				await publishStatus()
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
				await publishSessions()
				await publishStatus()
				break
			}
			case 'reset': {
				await appendMessages(sid, [{ type: 'reset', ts: new Date().toISOString() }])
				await appendEvent({
					id: eventId(), type: 'line', sessionId: sid,
					text: '[reset] conversation cleared', level: 'meta',
					createdAt: new Date().toISOString(),
				})
				break
			}
			case 'topic': {
				const info = sessions.get(sid)
				if (info && cmd.text) {
					info.topic = cmd.text
					await saveMeta(info)
					await publishSessions()
				}
				break
			}
			case 'model': {
				const info = sessions.get(sid)
				if (info && cmd.text) {
					info.model = cmd.text
					await saveMeta(info)
					await publishSessions()
					await appendEvent({
						id: eventId(), type: 'line', sessionId: sid,
						text: `[model] switched to ${cmd.text}`, level: 'meta',
						createdAt: new Date().toISOString(),
					})
				}
				break
			}
		}
	}

	return {
		sessions,
		activeSessionId,
		busySessionIds,
		stop() { stopped = true },
	}
}
