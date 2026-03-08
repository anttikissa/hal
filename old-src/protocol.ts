import { randomBytes } from 'crypto'
import type { SessionInfo } from './session.ts'

export type { SessionInfo }

export type CommandType =
	| 'prompt'
	| 'pause'
	| 'resume'
	| 'steer'
	| 'drop'
	| 'queue'
	| 'handoff'
	| 'reset'
	| 'open'
	| 'close'
	| 'restart'
	| 'model'
	| 'system'
	| 'cd'
	| 'fork'
	| 'topic'

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

export type EventLevel = 'info' | 'warn' | 'error' | 'tool' | 'meta' | 'fork' | 'notice' | 'status'

export interface ToolProgressEntry {
	name: string
	inputSummary: string
	status: 'running' | 'done'
	elapsed: number
	bytes: number
	totalLines: number
	lastLines: string[]
}

export type RuntimeEvent =
	| {
			id: string
			type: 'line'
			sessionId: string | null
			text: string
			level: EventLevel
			createdAt: string
	  }
	| {
			id: string
			type: 'chunk'
			sessionId: string | null
			text: string
			channel: 'assistant' | 'thinking'
			createdAt: string
	  }
	/**
	 * Global runtime status. Emitted on busy/idle transitions and after each
	 * API response. Drives the TUI statusline — never shown in scrollback.
	 *
	 * `context` carries the latest token usage so the statusline can show a
	 * percentage bar. The server always includes it when known; the client
	 * computes `used / max` for display.
	 */
	| {
			id: string
			type: 'status'
			sessionId: string | null
			busySessionIds?: string[]
			pausedSessionIds?: string[]
			activeSessionId: string | null
			busy: boolean
			queueLength: number
			activity?: string
			context?: { used: number; max: number; estimated?: boolean }
			createdAt: string
	  }
	| {
			id: string
			type: 'sessions'
			activeSessionId: string | null
			sessions: SessionInfo[]
			createdAt: string
	  }
	| {
			id: string
			type: 'command'
			sessionId: string | null
			commandId: string
			phase: 'queued' | 'started' | 'done' | 'failed'
			message?: string
			createdAt: string
	  }
	| {
			id: string
			type: 'prompt'
			sessionId: string | null
			text: string
			label?: 'steering'
			source: RuntimeSource
			createdAt: string
	  }
	| {
			id: string
			type: 'tool_progress'
			sessionId: string | null
			tools: ToolProgressEntry[]
			createdAt: string
	  }

export interface RuntimeState {
	ownerPid: number | null
	ownerId: string | null
	busy: boolean
	queueLength: number
	busySessionIds: string[]
	activeSessionId: string | null
	sessions: SessionInfo[]
	commandsOffset: number
	updatedAt: string
}
