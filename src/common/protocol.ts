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
import type { Answers, Form } from './forms.ts'
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

// Text typed into a session but not sent yet, one per session, shared
// by every client (tasks/j1/states.md, Drafts and sending). `rev` counts
// the host's changes to it, so a client can tell whether its edit was
// based on the latest one.
export type Draft = { text: string; rev: number }

// `state` is the session's one state (src/common/states.ts); `inbox` the
// messages waiting for it (src/common/inbox.ts), also in `history`;
// the host always sends it, an older one may not. No draft: empty,
// never changed.
export type Snapshot = { meta: SessionMeta; history: HistoryRecord[]; state: SessionState; inbox?: InboxItem[]; turn?: LiveTurn; draft?: Draft }

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
	// With `amend`, an edit of the last prompt: the host decides from
	// history whether it replaces that prompt or is sent on top.
	| { type: 'submit'; sessionId: string; text: string; queue?: boolean; amend?: boolean }
	// Replace the session's draft. `base`: the draft rev the text was
	// edited from. If another client changed the draft since, the host
	// keeps both texts rather than lose one.
	| { type: 'draft'; sessionId: string; text: string; base?: number }
	// Escape: pause the running turn; it can continue later.
	| { type: 'pause'; sessionId: string }
	// Bare Enter: continue a paused turn, or retry a failed one.
	| { type: 'continue'; sessionId: string }
	// Answers the open question `question` (src/common/forms.ts), secrets
	// included; refused if it is not open (someone answered first).
	| { type: 'answer'; sessionId: string; question: string; answers: Answers }
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
	// prompt, after the running turn's output so far. `replaces`: an edit
	// that takes the place of the last prompt and everything after it.
	| { type: 'prompt'; sessionId: string; texts: string[]; replaces?: true }
	| { type: 'stream'; sessionId: string; event: LiveStreamEvent }
	// The host ran the round's tool calls and recorded these results; the
	// turn goes on with a new provider round, streamed after them.
	| { type: 'tool-results'; sessionId: string; results: ToolResultBlock[] }
	| { type: 'turn-end'; sessionId: string; status: TurnStatus; usage?: Usage; error?: string }
	// The turn asked a question, now in history; it waits for an answer
	// with no turn running (the state says blocked).
	| { type: 'question'; sessionId: string; id: string; form: Form }
	// The first answer to it, as history keeps it (secrets only named).
	| { type: 'answer'; sessionId: string; question: string; answers: Answers; secrets?: string[] }
	// Something the user should fix (config.ason); not tied to a session.
	| { type: 'warning'; text: string }
	// The session's draft changed; `command` is the id of the command
	// that changed it (a draft, or a submit that sent it).
	| { type: 'draft'; sessionId: string; draft: Draft; command?: string }
	// Sent only to the client whose command was refused.
	| { type: 'rejected'; sessionId?: string; command: string; reason: string; id?: string }
	// Sent only to the sender: the command with this id was carried out.
	| { type: 'ack'; id: string }

export type EventType = Event['type']

const commandTypes: CommandType[] = ['create', 'open-newest', 'open', 'close', 'submit', 'draft', 'pause', 'continue', 'answer']

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
	for (let flag of ['queue', 'amend']) if (c.type === 'submit' && c[flag] !== undefined && typeof c[flag] !== 'boolean') return `submit: ${flag} must be a boolean`
	if (c.type === 'draft' && c.base !== undefined && !Number.isInteger(c.base)) return 'draft: base must be an integer'
	if (c.type === 'answer') {
		let a = c.answers
		let strings = a && typeof a === 'object' && !Array.isArray(a) && Object.values(a).every((v) => typeof v === 'string')
		return str('sessionId') ?? str('question') ?? (strings ? undefined : 'answer: answers must map names to strings')
	}
	return str('sessionId') ?? (c.type === 'submit' || c.type === 'draft' ? str('text') : undefined)
}

export const protocol = { commandTypes, invalid }
