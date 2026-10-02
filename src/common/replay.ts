// Session history records (one per line in sessions/<id>/history.asonl)
// and the rebuild of provider input from them. Provider input comes from
// these records alone, never from display state.

import type { AssistantBlock, Message, StopReason, ToolResultBlock, Usage, UserBlock, UserText } from './blocks.ts'
import { titles } from './titles.ts'
import type { ContextTransition } from './context-transition.ts'
import type { Answers, Form } from './forms.ts'

// `paused`: the user stopped the turn (tasks/j1/states.md); it can
// continue. `cancelled` and `interrupted` are only in older histories
// (the old Escape and restart) and read as paused.
export type TurnStatus = 'completed' | 'paused' | 'error' | 'cancelled' | 'interrupted'

// A hash names raw bytes in the session's file-blobs/. Metadata-only
// snapshots cover large/sensitive files; null means absent (8w).
export type FileSnapshot = string | { size: number; mtime: number } | null
export type FileChange =
	| { path: string; before: FileSnapshot; after: FileSnapshot; undeclared?: never }
	| { path: string; undeclared: true; statusBefore: string | null; statusAfter: string | null; before?: never; after?: never }

// Every record has `n`, its number in the session (task w5): 1, 2, 3...,
// given by the host, the one writer of a home's histories, so numbers
// never collide; elsewhere a record is named '<session id>#<n>'. A
// streamed assistant block is numbered when it starts streaming, so
// records may be written out of number order. Records of old histories
// have no `n` on disk and get their byte offset + 1 when read (pages.ts),
// which no later number reuses. Absent only in records built by hand.
export type HistoryRecord = Numbered &
	(
	// A submitted prompt, or tool results. `inbox`: the ids of the inbox
	// messages it delivers, which are its first text blocks. `replaces`:
	// an edit of the last prompt (tasks/j1/states.md, Editing the last
	// prompt); it supersedes that prompt and everything after it.
	| { type: 'user'; blocks: UserBlock[]; naming?: { turn: number; version: number; name: string; eligible: boolean }; command?: string; inbox?: string[]; queued?: true; replaces?: true; ts: string }
	// A message sent while the session was busy, waiting in the inbox
	// (src/common/inbox.ts) until a prompt record delivers it. Not
	// provider input by itself. `id`: the client's command id, if any.
	// Sender fields (from, label, advisory): another session sent it
	// (task rj); none, the human. A later
	// record with the same id is an edit of the waiting message (task
	// dg): its new text, in the same place; `withdrawn` takes it out
	// (edited into a slash command). `command`: the edit's command id.
	| { type: 'inbox'; id: string; text: string; queue?: true; from?: string; label?: string; advisory?: true; summary?: string; withdrawn?: true; command?: string; origin?: 'model'; generatingCommand?: 'clear'; ts: string }
	// One assistant block, appended as soon as it is complete.
	// `ts`: when the block started streaming; `model`, `effort`: what
	// wrote it (task hp; older records have neither).
	| { type: 'assistant'; block: AssistantBlock; model?: string; effort?: string; ts: string }
	// Ends one model turn, or pauses it (then `pauseReason` if Hal, not
	// the user, paused it). `usage`: all its rounds'; `context`: the
	// tokens its last round with usage took in (status row, task 1g).
	// A turn with no end is unfinished: the host
	// died or restarted mid-turn, and the next host continues it.
	| { type: 'turn_end'; status: TurnStatus; reason?: StopReason; error?: string; pauseReason?: string; usage: Usage; context?: number; ts: string }
	// The turn goes on after a pause, a failure or a host that went away.
	| { type: 'continue'; ts: string }
	// A durable question (tasks/w4/forms.md): the turn waits, blocked,
	// with nothing in memory, until an answer re-runs whoever asked.
	// `call`: the tool call it asks approval for (host/approval.ts).
	// `usage`: the turn's usage so far, which the answered turn goes on
	// from, as nothing of the turn stays in memory while it waits.
	// `from`: the slash command that asked, re-run with the answer;
	// without it, the turn asked.
	| { type: 'question'; id: string; form: Form; call?: string; usage?: Usage; from?: { command: string; args: string }; ts: string }
	// The first answer to question `question`. Secret fields are left
	// out of `answers` and only named in `secrets`. `cancelled`: Escape
	// dismissed a command's question; nothing was answered.
	| { type: 'answer'; question: string; answers: Answers; secrets?: string[]; cancelled?: true; ts: string }
	// A slash command (src/host/commands/), as typed. `from`: the session
	// that sent it; `origin: model` identifies Hal's command tool. Without
	// either, the human typed it (legacy provenance is unknown). `command`: the
	// client's id for the submit, so a resend is recognised.
	| { type: 'command'; text: string; origin?: 'model'; from?: string; label?: string; command?: string; ts: string }
	// What a command said; `error` if it failed.
	| { type: 'output'; text: string; error?: true; synthetic?: true; transition?: ContextTransition; transitionDone?: string; transitionCancel?: string; ts: string }
	// The session's cwd (/cd) or model changed. Not a turn; the model is
	// told in front of its next prompt.
	| { type: 'change'; cwd?: string; model?: string; ts: string }
	// Observed changes during bash, not proof of authorship; not provider input.
	| { type: 'file_changes'; toolId: string; cwd: string; files: FileChange[]; ts: string }
	// One provider round's own usage (task c4), after its blocks: the
	// context graph's points. `block`: the number of the round's first
	// assistant record. Not provider input, not shown in the transcript.
	| { type: 'round'; usage: Usage; model?: string; block?: number; ts: string }
	// A context boundary: `keep` names this turn's prompts, replayed
	// verbatim (including images) after the summary, not summarised into it.
	| { type: 'compact'; summary: string; prompts: number; keep?: number[]; transition?: string; ts: string }
	// A fresh context (/clear, task vh): provider input is rebuilt from
	// the records after it alone, with no summary.
	| { type: 'reset'; transition?: string; ts: string }
	)

// Copied records retain their original session through repeated forks (v6).
type Numbered = { n?: number; originSession?: string }

// Provider messages from history. Unsigned thinking (a cut-off stream) is
// not replayable and is left out. Each tool call gets a result before the
// next user message: a missing one becomes an error result, and results
// with no call are dropped, so the input stays valid for every provider.
// Each prompt is its own message, starting with its [HH:MM] line (with
// the date on the first prompt and when it changed; replay.clock) and, if
// the turn before it failed or was paused, a <meta> note saying so (and
// notes for a cwd or model that changed since the last prompt):
// providers join adjacent text blocks with no separator, so merged
// prompts read as one ("pong" + "k" became "pongk").
//
// Only the records after the latest compact or reset count; a compact's
// summary is the first user message.
function toMessages(records: HistoryRecord[]): Message[] {
	records = replay.current(records)
	let at = records.findLastIndex((r) => r.type === 'compact' || r.type === 'reset')
	let boundary = records[at]
	let kept = boundary?.type === 'compact' ? new Set(boundary.keep ?? []) : new Set<number>()
	let prompts = records.slice(0, at).filter((r) => r.type === 'user' && r.n !== undefined && kept.has(r.n))
	if (at >= 0) records = [...prompts, ...records.slice(at + 1)]
	let out: Message[] = boundary?.type === 'compact' ? [{ role: 'user', blocks: [{ type: 'text', text: boundary.summary }] }] : []
	let pending: string[] = []
	let status: TurnStatus | undefined
	let note: string | undefined
	let changed: { cwd?: string; model?: string } = {}
	let push = (msg: Message) => {
		let last = out.at(-1)
		if (last?.role === msg.role) (last.blocks as unknown[]).push(...msg.blocks)
		else if (msg.blocks.length) out.push(msg)
	}
	let prev: HistoryRecord | undefined
	let stamped: string | undefined
	// The approval question the pending calls wait on, while unanswered:
	// none of them has run, and a continue runs them (host/approval.ts).
	let waiting: string | undefined
	for (let r of records) {
		if (r.type === 'question' && r.call !== undefined && pending.includes(r.call)) waiting = r.id
		if (r.type === 'answer' && r.question === waiting) waiting = undefined
		// For the human; whoever asked hears the answer another way.
		if (r.type === 'change') {
			if (r.cwd !== undefined) changed.cwd = r.cwd
			if (r.model !== undefined) changed.model = r.model
			continue
		}
		if (r.type === 'file_changes' || r.type === 'round' || r.type === 'inbox' || r.type === 'question' || r.type === 'answer' || r.type === 'command' || r.type === 'output' || r.type === 'compact' || r.type === 'reset') continue
		// Held calls go on waiting for their results.
		if (r.type === 'continue' && waiting !== undefined) {
			note = undefined
			continue
		}
		let before = prev
		prev = r
		if (r.type === 'turn_end') {
			status = r.status
			note = replay.endNote(r)
		} else if (r.type === 'continue') {
			note = undefined
			let why = before?.type === 'turn_end' ? before.status : 'interrupted'
			let cut = out.at(-1)?.role === 'assistant'
			let missing = pending.map((id): ToolResultBlock => ({ type: 'tool_result', id, output: replay.missingResult(why), isError: true }))
			pending = []
			waiting = undefined
			push({ role: 'user', blocks: missing })
			if (cut) push({ role: 'user', blocks: [{ type: 'text', text: replay.continueNote }] })
		} else if (r.type === 'assistant') {
			let b = r.block
			if (b.type === 'thinking' && !b.signature) continue
			if (b.type === 'tool_call') pending.push(b.id)
			push({ role: 'assistant', blocks: [b.type === 'text' ? { type: 'text', text: b.text } : { ...b }] })
		} else {
			let results = r.blocks.filter((b): b is ToolResultBlock => b.type === 'tool_result' && pending.includes(b.id))
			let answered = new Set(results.map((b) => b.id))
			let missing: ToolResultBlock[] = pending
				.filter((id) => !answered.has(id))
				.map((id): ToolResultBlock => ({ type: 'tool_result', id, output: replay.missingResult(status), isError: true }))
			pending = []
			waiting = undefined
			push({ role: 'user', blocks: [...results, ...missing] })
			let texts = r.blocks.filter((b): b is UserText => b.type === 'text')
			if (!texts.length) continue
			let head = [`[${replay.clock(r.ts, stamped)}]`, ...(note ? [note] : []), ...replay.changeNotes(changed)].join('\n')
			stamped = r.ts
			note = undefined
			changed = {}
			// Never merged: a prompt always starts a message of its own. Its
			// texts (several when it delivers the inbox) are one block.
			// Its images (task 2a) follow the text.
			let images = r.blocks.filter((b) => b.type === 'image')
			let nudge = r.naming ? `\n<meta>Current session name: ${JSON.stringify(r.naming.name)}.${r.naming.eligible ? ' If this is a placeholder or no longer describes the main task, use the command tool to run /rename with a specific 3–7-word human-readable description, at most 60 Unicode characters, in the user language. Do not copy the user request or rename merely to polish wording. Never emit XML rename tags. Do not answer this metadata.' : ''}</meta>` : ''
			out.push({ role: 'user', blocks: [{ type: 'text', text: `${head}\n${texts.map((b) => replay.framed(b)).join('\n\n')}${nudge}` }, ...images.map((b) => ({ ...b }))] })
		}
	}
	return out
}

// A prompt text as the model reads it: another session's message under
// an [Inbox · sender] line (tab, id and name), an advisory one also
// saying it needn't drop its work for it.
function framed(b: UserText): string {
	if (b.generatingCommand) return `[${titles.author({ ...b, type: 'prompt' })}]\n${b.text}`
	if (b.origin === 'model') return `[Hal]\n${b.text}`
	if (b.from === undefined) return b.text
	let head = `[Inbox · ${b.label ?? b.from}]`
	return b.advisory ? `${head}\n${replay.advisoryNote}\n${b.text}` : `${head}\n${b.text}`
}

// Whether the record is a prompt: a user record with text.
function isPrompt(r: HistoryRecord): r is Extract<HistoryRecord, { type: 'user' }> {
	return r.type === 'user' && r.blocks.some((b) => b.type === 'text')
}

// Index of the last prompt record, or -1.
function lastPrompt(records: HistoryRecord[]): number {
	for (let i = records.length - 1; i >= 0; i--) if (replay.isPrompt(records[i]!)) return i
	return -1
}

// History as the conversation now stands: each edited prompt in place
// of the prompt it replaces and everything after that. Inbox, answer
// and change records are kept: the inbox is read from every record, an
// answer may be to a question asked before, and a change still holds.
function current(records: HistoryRecord[]): HistoryRecord[] {
	if (!records.some((r) => r.type === 'user' && r.replaces)) return records
	let out: HistoryRecord[] = []
	for (let r of records) {
		if (r.type === 'user' && r.replaces) {
			let at = replay.lastPrompt(out)
			if (at >= 0) out = [...out.slice(0, at), ...out.slice(at).filter((x) => x.type === 'inbox' || x.type === 'answer' || x.type === 'change')]
		}
		out.push(r)
	}
	return out
}

// The records of turns alone: without slash commands, what they said,
// the questions they asked and the changes and context boundaries they
// made. Commands run beside turns and never change how one stands.
// Sparse state marks may keep an older command answer but only the newest
// question. An answer without its question is not evidence of a turn:
// leaving it in would make an idle tab look permanently working.
function withoutCommands(records: HistoryRecord[]): HistoryRecord[] {
	let questions = new Map(records.flatMap((r) => (r.type === 'question' ? [[r.id, r] as const] : [])))
	return records.filter((r) => {
		if (r.type === 'command' || r.type === 'output' || r.type === 'change' || r.type === 'compact' || r.type === 'reset') return false
		if (r.type === 'question') return !r.from
		return r.type !== 'answer' || (questions.has(r.question) && !questions.get(r.question)!.from)
	})
}

// How a turn ended, told in front of the next prompt; nothing when it
// completed. A long provider error is clipped: the model needs the gist.
function endNote(end: Extract<HistoryRecord, { type: 'turn_end' }>): string | undefined {
	if (end.status === 'completed') return undefined
	if (end.status === 'error') {
		let error = end.error ?? 'unknown error'
		if (error.length > 500) error = error.slice(0, 500) + '…'
		return `<meta>The previous turn failed with an error: ${error}</meta>`
	}
	if (end.pauseReason !== undefined) return `<meta>Hal paused the previous turn: ${end.pauseReason}</meta>`
	if (end.status === 'interrupted') return '<meta>The previous turn was interrupted.</meta>'
	return '<meta>The user paused the previous turn.</meta>'
}

// What changed since the last prompt, as notes for the next one.
function changeNotes(changed: { cwd?: string; model?: string }): string[] {
	let out: string[] = []
	if (changed.cwd !== undefined) out.push(`<meta>The working directory is now ${changed.cwd}</meta>`)
	if (changed.model !== undefined) out.push(`<meta>The model is now ${changed.model}</meta>`)
	return out
}

// Local wall-clock HH:MM of an ISO timestamp, as YYYY-MM-DD HH:MM if
// its date differs from that of `prev`, the last stamped prompt's (or
// there is none), so a stamp past midnight isn't read as a stale date.
function clock(ts: string, prev?: string): string {
	let two = (n: number) => String(n).padStart(2, '0')
	let day = (d: Date) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
	let d = new Date(ts)
	let time = `${two(d.getHours())}:${two(d.getMinutes())}`
	return prev !== undefined && day(new Date(prev)) === day(d) ? time : `${day(d)} ${time}`
}

// What the model is told about a call with no recorded result. A host
// that went away, or a pause, may have cut it off mid-run.
function missingResult(status: TurnStatus | undefined): string {
	if (status === 'interrupted' || status === 'paused') return 'No result: the turn was interrupted, so this tool call may or may not have run.'
	return `Tool call did not run: the turn ${status ?? 'ended'}.`
}

export const replay = {
	// Told to the model when a cut-off answer continues.
	continueNote: '<meta>The previous response was interrupted. Continue without repeating completed work.</meta>',
	// Told with an advisory message delivered while the model works.
	advisoryNote: '<meta>Another session sent this while you work: read it now, but you need not drop your current task for it.</meta>',
	toMessages,
	framed,
	isPrompt,
	lastPrompt,
	current,
	withoutCommands,
	endNote,
	changeNotes,
	clock,
	missingResult,
}
