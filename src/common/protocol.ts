// Host/client protocol: commands flow client → host, events host →
// client. Every message is plain serializable data (ASON-safe) and
// names its session, except `create`, whose reply names the new one.
//
// A client that opens a session gets one snapshot of it (conversation
// so far plus any in-progress turn) and then live events. Reconnecting
// is connecting again: there is no replay and no sequence numbers.
//
// Every command may carry an `id`, made by the client (connection.ts
// always adds one). The host answers it with `ack`, or `rejected`
// carrying the id, and ignores a repeat of an id it has acted on, so a
// command resent after a reconnect never acts twice.

import type { AssistantBlock, StreamEvent, ToolResultBlock, Usage } from './blocks.ts'
import type { InboxItem } from './inbox.ts'
import type { HistoryRecord, TurnStatus } from './replay.ts'
import type { SessionMeta } from './session.ts'
import type { SessionState } from './states.ts'

export type { TurnStatus } from './replay.ts'

// ── Conversation as clients see it ──
// A snapshot carries the session's durable history records as stored.

// The running turn's output streamed so far and not yet in history (its
// prompt, every finished block and any tool results already are). Clients continue it by
// folding later `stream` events with blocks.apply; at `turn-end` the
// host has recorded its blocks and the turn end, so its blocks, if any,
// followed by the turn end match what a later snapshot shows.
export type LiveTurn = { provider: string; blocks: AssistantBlock[]; usage: Usage }

// `state` is the session's one state (src/common/states.ts); `inbox` the
// messages waiting for it (src/common/inbox.ts), also in `history`;
// the host always sends it, an older one may not.
export type Snapshot = { meta: SessionMeta; history: HistoryRecord[]; state: SessionState; inbox?: InboxItem[]; turn?: LiveTurn }

// Stream events forwarded live; terminal done/error become `turn-end`.
export type LiveStreamEvent = Exclude<StreamEvent, { type: 'done' } | { type: 'error' }>

// ── Commands (client → host) ──

export type Command = (
	| { type: 'create'; cwd: string; model?: string; name?: string }
	// Open the newest session, or create one in cwd (the host's own
	// working directory if none is given) when there is none.
	| { type: 'open-newest'; cwd?: string }
	// Start following a session: a snapshot, then live events.
	| { type: 'open'; sessionId: string }
	// Stop following it. The session and any running turn carry on.
	| { type: 'close'; sessionId: string }
	// A prompt. While a turn is busy it waits in the inbox: steering, sent
	// before the turn's next request; with `queue`, run after it ends.
	| { type: 'submit'; sessionId: string; text: string; queue?: boolean }
	// Escape: pause the running turn; it can continue later.
	| { type: 'pause'; sessionId: string }
	// Bare Enter: continue a paused turn, or retry a failed one.
	| { type: 'continue'; sessionId: string }
) & { id?: string }

export type CommandType = Command['type']

// ── Events (host → client) ──

export type Event =
	| { type: 'snapshot'; sessionId: string; snapshot: Snapshot }
	// The prompt is now in history and a turn is running. No prompt: an
	// earlier turn continues (a `continue` record).
	| { type: 'turn-start'; sessionId: string; prompt?: string; provider: string }
	// The session's state changed.
	| { type: 'state'; sessionId: string; state: SessionState }
	// The inbox changed: every message now waiting.
	| { type: 'inbox'; sessionId: string; inbox: InboxItem[] }
	// Inbox messages (and maybe a new prompt) are in history as one
	// prompt, after the running turn's output so far.
	| { type: 'prompt'; sessionId: string; texts: string[] }
	| { type: 'stream'; sessionId: string; event: LiveStreamEvent }
	// The host ran the round's tool calls and recorded these results; the
	// turn goes on with a new provider round, streamed after them.
	| { type: 'tool-results'; sessionId: string; results: ToolResultBlock[] }
	| { type: 'turn-end'; sessionId: string; status: TurnStatus; usage?: Usage; error?: string }
	// Something the user should fix (config.ason); not tied to a session.
	| { type: 'warning'; text: string }
	// Sent only to the client whose command was refused.
	| { type: 'rejected'; sessionId?: string; command: string; reason: string; id?: string }
	// Sent only to the sender: the command with this id was carried out.
	| { type: 'ack'; id: string }

export type EventType = Event['type']

const commandTypes: CommandType[] = ['create', 'open-newest', 'open', 'close', 'submit', 'pause', 'continue']

// Why `value` is not a well-formed command, or undefined if it is.
// Commands cross a process boundary, so the host checks before acting.
function invalid(value: unknown): string | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return 'command must be an object'
	let c = value as Record<string, unknown>
	if (!commandTypes.includes(c.type as CommandType)) return `unknown command type ${JSON.stringify(c.type)}`
	let str = (key: string, optional = false) =>
		(optional && c[key] === undefined) || typeof c[key] === 'string' ? undefined : `${c.type}: ${key} must be a string`
	let problem = str('id', true)
	if (problem) return problem
	if (c.type === 'create') return str('cwd') ?? str('model', true) ?? str('name', true)
	if (c.type === 'open-newest') return str('cwd', true)
	if (c.type === 'submit' && c.queue !== undefined && typeof c.queue !== 'boolean') return 'submit: queue must be a boolean'
	return str('sessionId') ?? (c.type === 'submit' ? str('text') : undefined)
}

export const protocol = { commandTypes, invalid }
