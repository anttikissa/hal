import { shortenHome } from '../tools.ts'
import { appendEvent, updateState } from '../ipc.ts'
import type { EventLevel, RuntimeEvent, RuntimeSource, SessionInfo } from '../protocol.ts'

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g

let ownerId: string
let eventCounter = 0

function eventId(): string {
	eventCounter += 1
	return `${Date.now()}-${process.pid}-${eventCounter}`
}

export function initPublisher(owner: string): void {
	ownerId = owner
}

type EventPayload =
	| Omit<Extract<RuntimeEvent, { type: 'line' }>, 'id' | 'createdAt'>
	| Omit<Extract<RuntimeEvent, { type: 'chunk' }>, 'id' | 'createdAt'>
	| Omit<Extract<RuntimeEvent, { type: 'status' }>, 'id' | 'createdAt'>
	| Omit<Extract<RuntimeEvent, { type: 'sessions' }>, 'id' | 'createdAt'>
	| Omit<Extract<RuntimeEvent, { type: 'command' }>, 'id' | 'createdAt'>
	| Omit<Extract<RuntimeEvent, { type: 'prompt' }>, 'id' | 'createdAt'>

async function emit(payload: EventPayload): Promise<void> {
	const event = {
		...payload,
		createdAt: new Date().toISOString(),
		id: eventId(),
	} as RuntimeEvent
	await appendEvent(event)
}

export async function publishLine(
	text: string,
	level: EventLevel,
	sessionId: string | null,
): Promise<void> {
	await emit({
		type: 'line',
		sessionId,
		text: shortenHome(text.replace(ANSI_PATTERN, '')),
		level,
	})
}

export async function publishChunk(
	text: string,
	channel: 'assistant' | 'thinking',
	sessionId: string | null,
): Promise<void> {
	await emit({ type: 'chunk', sessionId, text, channel })
}

export async function publishCommandPhase(
	commandId: string,
	phase: 'queued' | 'started' | 'done' | 'failed',
	message: string | undefined,
	sessionId: string | null,
): Promise<void> {
	await emit({ type: 'command', sessionId, commandId, phase, message })
}

export async function publishPrompt(
	sessionId: string | null,
	text: string,
	source: RuntimeSource,
): Promise<void> {
	await emit({ type: 'prompt', sessionId, text, source })
}

export interface StatusSnapshot {
	busySessionIds: string[]
	pausedSessionIds: string[]
	activeSessionId: string | null
	registryActiveSessionId: string | null
	queueLength: number
	sessions: SessionInfo[]
}

export async function publishStatus(snapshot: StatusSnapshot): Promise<void> {
	const {
		busySessionIds,
		pausedSessionIds,
		activeSessionId,
		registryActiveSessionId,
		queueLength,
		sessions,
	} = snapshot
	const busy = busySessionIds.length > 0
	const effectiveActiveId = registryActiveSessionId ?? activeSessionId

	await updateState((state) => {
		if (state.ownerId === ownerId) {
			state.busy = busy
			state.queueLength = queueLength
			state.busySessionIds = busySessionIds
			state.activeSessionId = effectiveActiveId ?? null
			state.sessions = sessions
		}
	})

	await emit({
		type: 'status',
		sessionId: busySessionIds[0] ?? null,
		busySessionIds,
		pausedSessionIds,
		activeSessionId: effectiveActiveId ?? null,
		busy,
		queueLength,
	})

	await emit({ type: 'sessions', activeSessionId: effectiveActiveId ?? null, sessions })
}

export async function publishActivity(activity: string, sessionId: string | null): Promise<void> {
	await emit({
		type: 'status',
		sessionId,
		busySessionIds: [],
		activeSessionId: null,
		busy: true,
		queueLength: 0,
		activity,
	})
}

/** Emit a lightweight status event carrying only context token data (for statusline). */
export async function publishContext(
	sessionId: string | null,
	context: { used: number; max: number },
): Promise<void> {
	await emit({
		type: 'status',
		sessionId,
		busySessionIds: [],
		activeSessionId: null,
		busy: false,
		queueLength: 0,
		context,
	})
}
