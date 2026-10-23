// A session as a client first sees it (the `snapshot` event of
// src/common/protocol.ts): durable history records as stored, plus the
// running turn, draft and status-row stats. Tasks: 6, bq, 1g, j1.

import type { AssistantBlock, Usage } from './blocks.ts'
import type { InboxItem } from './inbox.ts'
import type { HistoryRecord } from './replay.ts'
import type { SessionMeta } from './session.ts'
import type { SessionState } from './states.ts'

// The running turn's output streamed so far and not yet in history (its
// prompt, every finished block and any tool results already are). Clients continue it by
// folding later `stream` events with blocks.apply; at `turn-end` the
// host has recorded its blocks and the turn end, so its blocks, if any,
// followed by the turn end match what a later snapshot shows. `ns`: each
// block's record number (HistoryRecord `n`), given when it started
// streaming and kept by its record.
// `model`, `effort`: what writes the turn; `ts`: when each block
// started (task hp).
export type LiveTurn = {
	provider: string
	model?: string
	effort?: string
	blocks: AssistantBlock[]
	usage: Usage
	ns?: number[]
	ts?: string[]
}

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
	// Stable numbers removed by rebase, for links without transcript placeholders.
	dropped?: number[]
	meta: SessionMeta
	rewrites?: { n: number; text: string; after?: number }[]
	history: HistoryRecord[]
	state: SessionState
	inbox?: InboxItem[]
	queueHold?: string
	turn?: LiveTurn
	// Bash output still in flight, one per running call or background job:
	// not history or provider input. `from`: characters dropped before it.
	toolOutput?: { id: string; output: string; from: number }[]
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
// (1-based), the key into the client-wide subscription usage store.
export type Stats = { context?: number; window?: number; files?: number; plan?: Plan; effort?: string }
export type Plan = { account: number; accounts: number; key: string }
