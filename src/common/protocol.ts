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

import type { AssistantBlock, ImageBlock, Sender, StreamEvent, ToolResultBlock, Usage } from './blocks.ts'
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
// `history` is the tail of the session's history (task bq): whole
// records within a byte budget, starting at a prompt when one is in
// reach. `older`: where it starts (a byte offset), when earlier records
// exist; a client asks for them with `history` commands. `earlier`: the
// records from before the tail that the state needs, such as an open
// question or the last prompt of a turn the tail cuts.
export type Snapshot = {
	meta: SessionMeta
	history: HistoryRecord[]
	state: SessionState
	inbox?: InboxItem[]
	turn?: LiveTurn
	draft?: Draft
	older?: number
	earlier?: HistoryRecord[]
}

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
	// History records ending at byte offset `before` (a snapshot's or
	// page's `older`), about one snapshot's worth; answered, to this
	// client only, with `history`.
	| { type: 'history'; sessionId: string; before: number }
	// Stop following it. The session and any running turn carry on.
	| { type: 'close'; sessionId: string }
	// A prompt. While a turn is busy it waits in the inbox: steering, sent
	// before the turn's next request; with `queue`, run after it ends.
	// With `amend`, an edit of the last prompt: the host decides from
	// history whether it replaces that prompt or is sent on top; with
	// `edits` too, an edit of that inbox message while it still waits.
	// A slash command (/name args) runs on the host at once instead.
	// Always the human's: another session's messages come from the host
	// (the send tool), never from what a client claims (task rj).
	| { type: 'submit'; sessionId: string; text: string; queue?: boolean; amend?: boolean; edits?: string }
	// Tab: complete the slash command `text` on the host; answered, to
	// this client only, with `completions`.
	| { type: 'complete'; sessionId: string; text: string }
	// Ctrl-M: the models to pick from; answered, to this client only,
	// with `models`. Nothing is recorded.
	| { type: 'models'; sessionId: string }
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
	// Tabs (src/host/tabs.ts): the sessions open as tabs, in order, shared
	// by every client; unlike open/close, which follow a session. A tab
	// command that creates, reopens or picks a tab names it in its ack.
	// A new session in cwd with the default model, after `after` (else last).
	| { type: 'tab-new'; cwd: string; after?: string }
	// Out of the tabs, remembering its position; the session and any
	// running turn carry on. Closing the last tab is refused.
	| { type: 'tab-close'; sessionId: string }
	// Reopen that closed session, or the most recently closed one, where
	// it was.
	| { type: 'tab-resume'; sessionId?: string }
	| { type: 'tab-move'; sessionId: string; index: number }
	// The tab a starting client shows: `last` if still open and in cwd,
	// else the first open tab in cwd, else a new tab in cwd. With no cwd
	// (the browser) any tab counts, and a new one goes in the host's
	// working directory.
	| { type: 'tab-start'; cwd?: string; last?: string }
	// A client showed the tab: it no longer wants attention.
	| { type: 'tab-seen'; sessionId: string }
	// An attachment for a later prompt (task 2a): `data` is base64 of a
	// png, jpeg, gif or webp image or of text/plain, at most
	// attachments.maxBytes() decoded. Answered, to this client only, with
	// `attached`; a prompt names it by that event's marker.
	| { type: 'attach'; sessionId: string; mediaType: string; data: string; name?: string }
) & { id?: string }

export type CommandType = Command['type']

// One tab as the tab bar needs it, without opening the session.
// `attention`: its turn ended, failed or asked since a client showed it.
export type Tab = { id: string; name: string; cwd: string; model: string; state: SessionState; attention?: true }

// ── Events (host → client) ──

export type Event =
	| { type: 'snapshot'; sessionId: string; snapshot: Snapshot }
	// The prompt is now in history and a turn is running. No prompt: an
	// earlier turn continues (a `continue` record). `images`: the
	// prompt's image blocks, after its text. `sender`: who sent the
	// prompt, if not the human.
	| { type: 'turn-start'; sessionId: string; prompt?: string; images?: ImageBlock[]; sender?: Sender; provider: string }
	// A page of earlier history, answering the `history` command for
	// `before`: whole records ending there, oldest first. `older`: where
	// they start, when there are more before them.
	| { type: 'history'; sessionId: string; before: number; records: HistoryRecord[]; older?: number }
	// The session's state changed.
	| { type: 'state'; sessionId: string; state: SessionState }
	// The inbox changed: every message now waiting.
	| { type: 'inbox'; sessionId: string; inbox: InboxItem[] }
	// Inbox messages (and maybe a new prompt) are in history as one
	// prompt, after the running turn's output so far. `replaces`: an edit
	// that takes the place of the last prompt and everything after it.
	// `senders`: who sent each text ({} the human), when not all the human.
	| { type: 'prompt'; sessionId: string; texts: string[]; senders?: Sender[]; images?: ImageBlock[]; replaces?: true }
	| { type: 'stream'; sessionId: string; event: LiveStreamEvent }
	// The host ran the round's tool calls and recorded these results; the
	// turn goes on with a new provider round, streamed after them.
	| { type: 'tool-results'; sessionId: string; results: ToolResultBlock[] }
	| { type: 'turn-end'; sessionId: string; status: TurnStatus; usage?: Usage; error?: string }
	// The turn asked a question, now in history; it waits for an answer
	// with no turn running (the state says blocked).
	| { type: 'question'; sessionId: string; id: string; form: Form }
	// The first answer to it, as history keeps it (secrets only named).
	// `cancelled`: Escape dismissed a command's question.
	| { type: 'answer'; sessionId: string; question: string; answers: Answers; secrets?: string[]; cancelled?: true }
	// A slash command is in history (`from`: as in submit) and runs.
	| { type: 'command'; sessionId: string; text: string; from?: string }
	// What a command said, now in history; `error` if it failed.
	| { type: 'output'; sessionId: string; text: string; error?: true }
	// The session's metadata changed (a /cd).
	| { type: 'meta'; sessionId: string; meta: SessionMeta }
	// Sent only to the client that asked: every full text `text` may
	// complete to, none if nothing fits.
	| { type: 'completions'; sessionId: string; text: string; items: string[] }
	// Open the model picker: the session's model and every model id to
	// offer. Sent to the client that asked (`models`), or to every
	// follower when /model runs alone.
	| { type: 'models'; sessionId: string; current: string; items: string[] }
	// Sent only to the client that attached: the command `command` (its
	// id) stored blob `blob`, which a prompt names with `marker`.
	| { type: 'attached'; sessionId: string; command: string; blob: string; marker: string }
	// Something the user should fix (config.ason, a marker naming no
	// attachment of the session); not tied to a session.
	| { type: 'warning'; text: string }
	// The tabs changed (or a client started): every tab, in order. Sent
	// to every client; which one a client shows is its own business.
	| { type: 'tabs'; tabs: Tab[] }
	// The session's draft changed; `command` is the id of the command
	// that changed it (a draft, or a submit that sent it).
	| { type: 'draft'; sessionId: string; draft: Draft; command?: string }
	// Sent only to the client whose command was refused.
	| { type: 'rejected'; sessionId?: string; command: string; reason: string; id?: string }
	// Sent only to the sender: the command with this id was carried out.
	// `tab`: the tab a tab command created, reopened or picked.
	| { type: 'ack'; id: string; tab?: string }

export type EventType = Event['type']

const commandTypes: CommandType[] = ['create', 'open-newest', 'open', 'history', 'close', 'submit', 'draft', 'pause', 'continue', 'answer', 'complete', 'models', 'attach', 'tab-new', 'tab-close', 'tab-resume', 'tab-move', 'tab-start', 'tab-seen']

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
	if (c.type === 'tab-new') return str('cwd') ?? str('after', true)
	if (c.type === 'tab-start') return str('cwd', true) ?? str('last', true)
	if (c.type === 'tab-resume') return str('sessionId', true)
	if (c.type === 'history' && !(Number.isInteger(c.before) && (c.before as number) >= 0)) return 'history: before must be an offset'
	if (c.type === 'tab-move' && !Number.isInteger(c.index)) return 'tab-move: index must be an integer'
	for (let flag of ['queue', 'amend']) if (c.type === 'submit' && c[flag] !== undefined && typeof c[flag] !== 'boolean') return `submit: ${flag} must be a boolean`
	if (c.type === 'draft' && c.base !== undefined && !Number.isInteger(c.base)) return 'draft: base must be an integer'
	if (c.type === 'answer') {
		let a = c.answers
		let strings = a && typeof a === 'object' && !Array.isArray(a) && Object.values(a).every((v) => typeof v === 'string')
		return str('sessionId') ?? str('question') ?? (strings ? undefined : 'answer: answers must map names to strings')
	}
	if (c.type === 'attach') return str('sessionId') ?? str('mediaType') ?? str('data') ?? str('name', true)
	if (c.type === 'submit') return str('sessionId') ?? str('text') ?? str('edits', true)
	return str('sessionId') ?? (c.type === 'draft' || c.type === 'complete' ? str('text') : undefined)
}

export const protocol = { commandTypes, invalid }
