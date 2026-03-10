// IPC protocol types — commands, events, state.

import { randomBytes } from 'crypto'

// ── Session info ──

export interface SessionInfo {
	id: string
	name?: string
	topic?: string
	model?: string
	log?: string
	workingDir: string
	createdAt: string
	updatedAt: string
	closedAt?: string
	lastPrompt?: string
	context?: { used: number; max: number }
}

// ── Commands (client → host) ──

export type CommandType =
	| 'prompt'
	| 'pause'
	| 'continue'
	| 'resume'
	| 'steer'
	| 'reset'
	| 'compact'
	| 'open'
	| 'close'
	| 'model'
	| 'fork'
	| 'topic'
	| 'respond'

export interface RuntimeSource {
	kind: 'cli' | 'web'
	clientId: string
}

export interface RuntimeCommand {
	id: string
	type: CommandType
	sessionId?: string | null
	text?: string
	source: RuntimeSource
	createdAt: string
}

export function makeCommand(
	type: CommandType,
	source: RuntimeSource,
	text?: string,
	sessionId?: string | null,
): RuntimeCommand {
	return {
		id: randomBytes(8).toString('hex'),
		type,
		sessionId: sessionId ?? null,
		text,
		source,
		createdAt: new Date().toISOString(),
	}
}

// ── Events (host → clients) ──

export type EventLevel = 'info' | 'warn' | 'error' | 'tool' | 'meta' | 'notice'

export type RuntimeEvent =
	| {
		id: string; type: 'line'; sessionId: string | null
		text: string; level: EventLevel; detail?: string; createdAt: string
	}
	| {
		id: string; type: 'chunk'; sessionId: string | null
		text: string; channel: 'assistant' | 'thinking'; createdAt: string
	}
	| {
		id: string; type: 'status'; sessionId: string | null
		busySessionIds: string[]; pausedSessionIds: string[]
		activeSessionId: string | null
		busy: boolean; queueLength: number
		activity?: string
		contexts?: Record<string, { used: number; max: number; estimated?: boolean }>
		createdAt: string
	}
	| {
		id: string; type: 'sessions'
		activeSessionId: string | null
		sessions: SessionInfo[]
		createdAt: string
	}
	| {
		id: string; type: 'command'; sessionId: string | null
		commandId: string; phase: 'queued' | 'started' | 'done' | 'failed'
		message?: string; createdAt: string
	}
	| {
		id: string; type: 'prompt'; sessionId: string | null
		text: string; label?: 'steering'
		source: RuntimeSource; createdAt: string
	}
	| {
		id: string; type: 'tool'; sessionId: string | null
		toolId: string; name: string; args: string
		phase: 'running' | 'streaming' | 'done' | 'error'
		output?: string; ref?: string; createdAt: string
	}
	| {
		id: string; type: 'question'; sessionId: string
		questionId: string; text: string; createdAt: string
	}
	| {
		id: string; type: 'answer'; sessionId: string
		question: string; text: string; createdAt: string
	}

// ── Snapshot state (for bootstrap) ──

export interface RuntimeState {
	hostPid: number | null
	hostId: string | null
	sessions: string[]
	activeSessionId: string | null
	busySessionIds: string[]
	eventsOffset: number
	updatedAt: string
}

export function defaultState(): RuntimeState {
	return {
		hostPid: null,
		hostId: null,
		sessions: [],
		activeSessionId: null,
		busySessionIds: [],
		eventsOffset: 0,
		updatedAt: new Date().toISOString(),
	}
}

// ── Helpers ──

let _counter = 0
export function eventId(): string {
	return `${Date.now().toString(36)}-${(++_counter).toString(36)}`
}
