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
import type { NoticeEntry, NoticeEvent } from './notices.ts'
import type { HistoryRecord, TurnStatus } from './replay.ts'
import type { SessionMeta } from './session.ts'
import type { FindBatch, FindFilter } from './find.ts'
import type { SessionState } from './states.ts'
import type { EffortCapability } from './effort.ts'
import { eventCheck } from './event-check.ts'
import type { PromptChange } from './prompt-changes.ts'

export type { TurnStatus } from './replay.ts'

// ── Conversation as clients see it ──
// A snapshot carries the session's durable history records as stored.

// The running turn's output streamed so far and not yet in history (its
// prompt, every finished block and any tool results already are). Clients continue it by
// folding later `stream` events with blocks.apply; at `turn-end` the
// host has recorded its blocks and the turn end, so its blocks, if any,
// followed by the turn end match what a later snapshot shows. `ns`: each
// block's record number (HistoryRecord `n`), given when it started
// streaming and kept by its record.
// `model`, `effort`: what writes the turn; `ts`: when each block
// started (task hp).
export type LiveTurn = { provider: string; model?: string; effort?: string; blocks: AssistantBlock[]; usage: Usage; ns?: number[]; ts?: string[] }

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
	// Foreground bash output still in flight: not history or provider input.
	toolOutput?: { id: string; output: string }
	draft?: Draft
	older?: number
	earlier?: HistoryRecord[]
	stats?: Stats
}

// What a session's status row shows that a client cannot work out
// (task 1g), as of the snapshot, the last turn end or model change;
// the host sends it with those, nothing polls. `context`: the tokens
// the last round took in (input, cache read and cache write);
// `window`: the model's context window, when known. `sent`, `received`:
// input and output tokens of the session's turns since this host
// started. `plan`: the subscription account the session's next request
// goes to: its place among the provider's subscription accounts
// (1-based), each usage window's percent used ("5h": 18) and, when
// known, when it resets (ISO).
export type Stats = { context?: number; window?: number; sent: number; received: number; files?: number; plan?: Plan; effort?: string }
export type Plan = { account: number; accounts: number; windows: Record<string, number>; resets?: Record<string, string> }

// Stream events forwarded live; terminal done/error become `turn-end`.
export type LiveStreamEvent = Exclude<StreamEvent, { type: 'done' } | { type: 'error' }>

// ── Commands (client → host) ──

export type Command = (
	| { type: 'create'; cwd: string; model?: string; name?: string }
	| { type: 'find'; request: string; query: string; kinds?: FindFilter[] }
	| { type: 'find-cancel' }
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
	// After an open tab: inherit its cwd, model and effort; otherwise use
	// cwd and the default model, appending the new tab.
	| { type: 'tab-new'; cwd: string; after?: string }
	// Out of the tabs, remembering its position; the session and any
	// running turn carry on. Closing the last tab is refused.
	| { type: 'tab-close'; sessionId: string }
	// Reopen that closed session, or the most recently closed one, where
	// it was.
	| { type: 'tab-resume'; sessionId?: string; timezone?: string }
	| { type: 'tab-move'; sessionId: string; index: number }
	// The tab a starting client shows: `last` if still open and in cwd,
	// else the first open tab in cwd, else a new tab in cwd. With no cwd
	// (the browser) any tab counts, and a new one goes in the host's
	// working directory. The tabs themselves come on connecting.
	// `timezone` (both): the client's IANA zone, untrusted (task wq).
	| { type: 'tab-start'; cwd?: string; last?: string; timezone?: string }
	// A client showed the tab: it no longer wants attention.
	| { type: 'tab-seen'; sessionId: string }
	// An attachment for a later prompt (task 2a): `data` is base64 of a
	// png, jpeg, gif or webp image or of text/plain, at most
	// attachments.maxBytes decoded. Answered, to this client only, with
	// `attached`; a prompt names it by that event's marker. A paste's
	// `name` (attachments.fileName, chosen by the client) makes its
	// marker [image/<name>] or [paste/<name>] (tasks qy, 31).
	| { type: 'attach'; sessionId: string; mediaType: string; data: string; name?: string }
	// A one-time web login code (host/web-auth.ts) for `./run auth`;
	// answered, to this client only, with `auth`. With `link` (a
	// terminal, task e3): a code for its web links, replaced by a new
	// `auth` event whenever it is used and before it grows old.
	| { type: 'auth'; link?: boolean }
	// A browser registers a push endpoint and reports its shown tab.
	// Both push commands are answered, to this client only, with `push-devices`.
	| { type: 'push-subscribe'; subscription: { endpoint: string; keys: { p256dh: string; auth: string } }; device?: string }
	| { type: 'push'; action: 'list' | 'remove' | 'test'; endpoint?: string }
	// Answered, to this client only, with `notice-history` (task py).
	| { type: 'notice-history' }
	| { type: 'visibility'; sessionId: string; visible: boolean }
	// A peer on the host socket names its process, for /clients (task z8).
	| { type: 'hello'; pid: number }
	// A terminal client's size and terminal (TERM, program, colour depth),
	// on connecting and on every resize, for the inspect tool; untrusted.
	| { type: 'screen'; cols: number; rows: number; term?: string }
) & { id?: string }

export type CommandType = Command['type']

// One tab as the tab bar needs it, without opening the session.
// `attention`: its turn ended, failed or asked since a client showed it.
// `hal`: its cwd is the Hal repo, which has its own prompt placeholders.
// `color`: the project color index (colors.project, task 22), only while
// open tabs span two or more projects.
export type Tab = { id: string; name: string; cwd: string; model: string; state: SessionState; attention?: true; hal?: true; color?: number }

// ── Events (host → client) ──

// `n` on an event that tells of a history record: that record's number
// (HistoryRecord `n`); on `stream`, the number of the block the event
// went into. Clients key transcript items by it (task w5).
export type Event =
	| FindBatch
	| { type: 'snapshot'; sessionId: string; snapshot: Snapshot }
	// The prompt is now in history and a turn is running. No prompt: an
	// earlier turn continues (a `continue` record). `images`: the
	// prompt's image blocks, after its text. `sender`: who sent the
	// prompt, if not the human. `command`: the client's id for the submit
	// that sent the prompt, so it can put the prompt in place of the one
	// it shows pending.
	| { type: 'turn-start'; sessionId: string; prompt?: string; images?: ImageBlock[]; sender?: Sender; queued?: true; provider: string; model?: string; effort?: string; n?: number; command?: string; ts?: string }
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
	// `command`: as in turn-start, for the last text.
	| { type: 'prompt'; sessionId: string; texts: string[]; senders?: Sender[]; images?: ImageBlock[]; queued?: true; replaces?: true; n?: number; command?: string; ts?: string }
	// `ts`: when the block it streams into started (task hp).
	| { type: 'stream'; sessionId: string; event: LiveStreamEvent; n?: number; ts?: string; model?: string; effort?: string }
	// New bytes only; a late joiner gets the same partial output in its snapshot.
	| { type: 'tool-output'; sessionId: string; id: string; at: number; chunk: string }
	// The host ran the round's tool calls and recorded these results; the
	// turn goes on with a new provider round, streamed after them.
	| { type: 'tool-results'; sessionId: string; results: ToolResultBlock[]; n?: number }
	| { type: 'turn-stats'; sessionId: string; stats: Stats }
	| { type: 'turn-end'; sessionId: string; status: TurnStatus; usage?: Usage; error?: string; n?: number; stats?: Stats }
	// A question, now in history. A turn's waits for an answer with no
	// turn running (the state says blocked). `command`: a slash command
	// asked, beside whatever the session does, placed like `command`
	// (`streaming`).
	| { type: 'question'; sessionId: string; id: string; form: Form; n?: number; command?: true; streaming?: true }
	// The first answer to it, as history keeps it (secrets only named).
	// `cancelled`: Escape dismissed a command's question.
	| { type: 'answer'; sessionId: string; question: string; answers: Answers; secrets?: string[]; cancelled?: true }
	// A slash command is in history (`from`: as in submit) and runs.
	// `command`: the client's id for the submit, as in turn-start.
	// `streaming`: the running round's last block was still streaming
	// (not in history yet), so this goes before it; else after all the
	// round's blocks (task rk).
	| { type: 'command'; sessionId: string; text: string; origin?: 'model'; from?: string; label?: string; ts?: string; n?: number; command?: string; streaming?: true }
	// What a command said, now in history; `error` if it failed.
	// `streaming`: as in command.
	| { type: 'output'; sessionId: string; text: string; ts?: string; error?: true; origin?: 'model'; change?: PromptChange; n?: number; streaming?: true }
	// A context boundary was recorded (tasks bc, vh): `text`, its divider.
	// `clear`: a /clear; clients drop everything shown before it.
	| { type: 'divider'; sessionId: string; text: string; ts?: string; clear?: true; n?: number; streaming?: true }
	// The session's metadata changed (a /cd, a /model: then `stats` too).
	| { type: 'meta'; sessionId: string; meta: SessionMeta; stats?: Stats }
	// Sent only to the client that asked: every full text `text` may
	// complete to, none if nothing fits.
	| { type: 'completions'; sessionId: string; text: string; items: string[]; descriptions?: string[] }
	// Open the model picker: the session's model and every model id to
	// offer. Sent to the client that asked (`models`), or to every
	// follower when /model runs alone. `names`: display names models.dev
	// gives some of them, which the search matches too. `refresh`: lists
	// arrived later; update a picker that is open, never open one.
	| { type: 'models'; sessionId: string; current: string; effort?: string; capabilities?: Record<string, EffortCapability>; items: string[]; names?: Record<string, string>; refresh?: true }
	// Sent only to the client that attached: the command `command` (its
	// id) stored blob `blob`, which a prompt names with `marker`.
	| { type: 'attached'; sessionId: string; command: string; blob: string; marker: string }
	// Something the user should fix (config.ason, a marker naming no
	// attachment of the session); not tied to a session.
	| { type: 'warning'; text: string }
	// Every registered push device; `result` reports a push-test.
	| { type: 'push-devices'; devices: { endpoint: string; device?: string; added?: string }[]; result?: string }
	// Past notices and pushes, newest first (task py).
	| { type: 'notice-history'; entries: NoticeEntry[] }
	// The tabs changed, or the client just connected: every tab, in
	// order. Sent to every client; which one a client shows is its own business.
	| { type: 'tabs'; tabs: Tab[] }
	// /go in this session changes only windows currently showing/following it.
	| { type: 'go'; sessionId: string; tab: string }
	// The session's draft changed; `command` is the id of the command
	// that changed it (a draft, or a submit that sent it).
	| { type: 'draft'; sessionId: string; draft: Draft; command?: string }
	// Sent only to the client whose command was refused.
	| { type: 'rejected'; sessionId?: string; command: string; reason: string; id?: string }
	// Sent only to the sender: the command with this id was carried out.
	// `tab`: the tab a tab command created, reopened or picked.
	| { type: 'ack'; id: string; tab?: string }
	// The one-time web login code an `auth` command asked for; `link`,
	// the host's web address, if it is meant for links (task e3).
	| { type: 'auth'; code: string; link?: string }
	// The host process's version (task n1), sent on connect once known
	// and to every client when the host learns it.
	| { type: 'version'; version: string }
	| { type: 'restart' } // /restart all: terminals exit; web waits for host return.
	| { type: 'web-update' } // Opted-in pages wait for the user to reload.
	// Repaint terminals following this session; no reload on the web.
	| { type: 'redraw'; sessionId: string }
	// Cached models.dev names on connect, model switch and catalog refresh.
	| { type: 'model-names'; names: Record<string, string> }
	// Another tab's turn ended or asks, sent only to clients watching
	// some other tab (task qm); `session`, not sessionId, so no client
	// takes it as that session's event.
	| NoticeEvent
export type EventType = Event['type']

const commandTypes: CommandType[] = ['find', 'find-cancel', 'create', 'open-newest', 'open', 'history', 'close', 'submit', 'draft', 'pause', 'continue', 'answer', 'complete', 'models', 'attach', 'tab-new', 'tab-close', 'tab-resume', 'tab-move', 'tab-start', 'tab-seen', 'auth', 'push-subscribe', 'push', 'notice-history', 'visibility', 'hello', 'screen']

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
	if (c.type === 'hello') return Number.isInteger(c.pid) ? undefined : 'hello: pid must be an integer'
	if (c.type === 'screen') {
		let size = (n: unknown) => Number.isInteger(n) && (n as number) > 0 && (n as number) <= 10000
		if (!size(c.cols) || !size(c.rows)) return 'screen: cols and rows must be integers from 1 to 10000'
		return str('term', true) ?? (((c.term as string | undefined)?.length ?? 0) > 200 ? 'screen: term exceeds 200 characters' : undefined)
	}
	if (c.type === 'find-cancel') return undefined
	if (c.type === 'find') {
		let kinds = c.kinds
		let valid = kinds === undefined || (Array.isArray(kinds) && kinds.every((k) => ['text', 'thinking', 'tools', 'other'].includes(k)))
		return str('request') ?? str('query') ?? ((c.query as string).length > 4096 ? 'find: query exceeds 4096 characters' : valid ? undefined : 'find: invalid kinds')
	}
	if (c.type === 'auth') return c.link === undefined || typeof c.link === 'boolean' ? undefined : 'auth: link must be a boolean'
	if (c.type === 'create') return str('cwd') ?? str('model', true) ?? str('name', true)
	if (c.type === 'open-newest') return str('cwd', true)
	if (c.type === 'tab-new') return str('cwd') ?? str('after', true)
	if (c.type === 'push-subscribe') {
		let s = c.subscription as Record<string, unknown> | undefined
		let keys = s?.keys as Record<string, unknown> | undefined
		let device = c.device === undefined || (typeof c.device === 'string' && c.device.length <= 80)
		return s && keys && device && typeof s.endpoint === 'string' && typeof keys.p256dh === 'string' && typeof keys.auth === 'string' ? undefined : 'push-subscribe: invalid subscription'
	}
	if (c.type === 'notice-history') return undefined
	if (c.type === 'push') return ['list', 'remove', 'test'].includes(c.action as string) ? str('endpoint', c.action === 'list') : 'push: invalid action'
	if (c.type === 'visibility') return str('sessionId') ?? (typeof c.visible === 'boolean' ? undefined : 'visibility: visible must be a boolean')
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

export const protocol = { commandTypes, invalid, invalidEvent: eventCheck.invalidEvent }
