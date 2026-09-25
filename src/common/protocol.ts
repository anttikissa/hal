// Host/client protocol: commands flow client → host, events host →
// client. Every message is plain serializable data (ASON-safe) and
// names its session, except `create`, whose reply names the new one.
//
// A client that opens a session gets one snapshot of it (conversation
// so far plus any in-progress turn) and then live events. Reconnecting
// is connecting again: there is no replay and no sequence numbers.

import type { AssistantBlock, StreamEvent, Usage } from './blocks.ts'
import type { SessionMeta } from './session.ts'

// ── Conversation as clients see it ──
// Protocol shape only; how the host stores history is its own business.

// How a turn ended. `interrupted`: the host died before it ended.
export type TurnStatus = 'completed' | 'cancelled' | 'error' | 'interrupted'

export type Entry =
	| { type: 'prompt'; text: string }
	| { type: 'assistant'; blocks: AssistantBlock[] }
	| { type: 'turn-end'; status: TurnStatus; usage?: Usage; error?: string }

// The running turn's output streamed so far and not yet in history (its
// prompt already is). Clients continue it by folding later `stream`
// events with blocks.apply; at `turn-end` its blocks, if any, become an
// assistant entry followed by the turn-end entry, exactly as the host
// records them.
export type LiveTurn = { provider: string; blocks: AssistantBlock[]; usage: Usage }

export type Snapshot = { meta: SessionMeta; history: Entry[]; turn?: LiveTurn }

// Stream events forwarded live; terminal done/error become `turn-end`.
export type LiveStreamEvent = Exclude<StreamEvent, { type: 'done' } | { type: 'error' }>

// ── Commands (client → host) ──

export type Command =
	| { type: 'create'; cwd: string; model?: string; name?: string }
	// Start following a session: a snapshot, then live events.
	| { type: 'open'; sessionId: string }
	// Stop following it. The session and any running turn carry on.
	| { type: 'close'; sessionId: string }
	| { type: 'submit'; sessionId: string; text: string }
	| { type: 'cancel'; sessionId: string }

export type CommandType = Command['type']

// ── Events (host → client) ──

export type Event =
	| { type: 'snapshot'; sessionId: string; snapshot: Snapshot }
	// The prompt entry is now in history and a turn is running.
	| { type: 'turn-start'; sessionId: string; prompt: string; provider: string }
	| { type: 'stream'; sessionId: string; event: LiveStreamEvent }
	| { type: 'turn-end'; sessionId: string; status: TurnStatus; usage?: Usage; error?: string }
	// Sent only to the client whose command was refused.
	| { type: 'rejected'; sessionId?: string; command: string; reason: string }

export type EventType = Event['type']

const commandTypes: CommandType[] = ['create', 'open', 'close', 'submit', 'cancel']

// Why `value` is not a well-formed command, or undefined if it is.
// Commands cross a process boundary, so the host checks before acting.
function invalid(value: unknown): string | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return 'command must be an object'
	let c = value as Record<string, unknown>
	if (!commandTypes.includes(c.type as CommandType)) return `unknown command type ${JSON.stringify(c.type)}`
	let str = (key: string, optional = false) =>
		(optional && c[key] === undefined) || typeof c[key] === 'string' ? undefined : `${c.type}: ${key} must be a string`
	if (c.type === 'create') return str('cwd') ?? str('model', true) ?? str('name', true)
	return str('sessionId') ?? (c.type === 'submit' ? str('text') : undefined)
}

export const protocol = { commandTypes, invalid }
