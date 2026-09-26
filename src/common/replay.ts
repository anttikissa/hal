// Session history records (one per line in sessions/<id>/history.asonl)
// and the rebuild of provider input from them. Provider input comes from
// these records alone, never from display state.

import type { AssistantBlock, Message, StopReason, ToolResultBlock, Usage, UserBlock } from './blocks.ts'
import type { Answers, Form } from './forms.ts'

// `paused`: the user stopped the turn (tasks/j1/states.md); it can
// continue. `cancelled` and `interrupted` are only in older histories
// (the old Escape and restart) and read as paused.
export type TurnStatus = 'completed' | 'paused' | 'error' | 'cancelled' | 'interrupted'

export type HistoryRecord =
	// A submitted prompt, or tool results. `inbox`: the ids of the inbox
	// messages it delivers, which are its first text blocks. `replaces`:
	// an edit of the last prompt (tasks/j1/states.md, Editing the last
	// prompt); it supersedes that prompt and everything after it.
	| { type: 'user'; blocks: UserBlock[]; command?: string; inbox?: string[]; replaces?: true; ts: string }
	// A message sent while the session was busy, waiting in the inbox
	// (src/common/inbox.ts) until a prompt record delivers it. Not
	// provider input by itself. `id`: the client's command id, if any.
	| { type: 'inbox'; id: string; text: string; queue?: true; ts: string }
	// One assistant block, appended as soon as it is complete.
	| { type: 'assistant'; block: AssistantBlock; ts: string }
	// Ends one model turn, or pauses it (then `pauseReason` if Hal, not
	// the user, paused it). A turn with no end is unfinished: the host
	// died or restarted mid-turn, and the next host continues it.
	| { type: 'turn_end'; status: TurnStatus; reason?: StopReason; error?: string; pauseReason?: string; usage: Usage; ts: string }
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
	// that sent it; without it the human typed it. `command`: the
	// client's id for the submit, so a resend is recognised.
	| { type: 'command'; text: string; from?: string; command?: string; ts: string }
	// What a command said; `error` if it failed.
	| { type: 'output'; text: string; error?: true; ts: string }
	// The session's cwd (/cd) or model changed. Not a turn; the model is
	// told in front of its next prompt.
	| { type: 'change'; cwd?: string; model?: string; ts: string }

// Provider messages from history. Unsigned thinking (a cut-off stream) is
// not replayable and is left out. Each tool call gets a result before the
// next user message: a missing one becomes an error result, and results
// with no call are dropped, so the input stays valid for every provider.
// Each prompt is its own message, starting with its [HH:MM] line and, if
// the turn before it failed or was paused, a <meta> note saying so (and
// notes for a cwd or model that changed since the last prompt):
// providers join adjacent text blocks with no separator, so merged
// prompts read as one ("pong" + "k" became "pongk").
function toMessages(records: HistoryRecord[]): Message[] {
	records = replay.current(records)
	let out: Message[] = []
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
		if (r.type === 'inbox' || r.type === 'question' || r.type === 'answer' || r.type === 'command' || r.type === 'output') continue
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
			push({ role: 'assistant', blocks: [{ ...b }] })
		} else {
			let results = r.blocks.filter((b): b is ToolResultBlock => b.type === 'tool_result' && pending.includes(b.id))
			let answered = new Set(results.map((b) => b.id))
			let missing: ToolResultBlock[] = pending
				.filter((id) => !answered.has(id))
				.map((id): ToolResultBlock => ({ type: 'tool_result', id, output: replay.missingResult(status), isError: true }))
			pending = []
			waiting = undefined
			push({ role: 'user', blocks: [...results, ...missing] })
			let texts = r.blocks.filter((b) => b.type === 'text')
			if (!texts.length) continue
			let head = [`[${replay.clock(r.ts)}]`, ...(note ? [note] : []), ...replay.changeNotes(changed)].join('\n')
			note = undefined
			changed = {}
			// Never merged: a prompt always starts a message of its own. Its
			// texts (several when it delivers the inbox) are one block.
			out.push({ role: 'user', blocks: [{ type: 'text', text: `${head}\n${texts.map((b) => b.text).join('\n\n')}` }] })
		}
	}
	return out
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
// the questions they asked and the changes they made. Commands run
// beside turns and never change how one stands.
function withoutCommands(records: HistoryRecord[]): HistoryRecord[] {
	let asked = new Set(records.flatMap((r) => (r.type === 'question' && r.from ? [r.id] : [])))
	return records.filter((r) => {
		if (r.type === 'command' || r.type === 'output' || r.type === 'change') return false
		if (r.type === 'question') return !r.from
		return r.type !== 'answer' || !asked.has(r.question)
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

// Local wall-clock HH:MM of an ISO timestamp.
function clock(ts: string): string {
	let d = new Date(ts)
	let two = (n: number) => String(n).padStart(2, '0')
	return `${two(d.getHours())}:${two(d.getMinutes())}`
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
	toMessages,
	isPrompt,
	lastPrompt,
	current,
	withoutCommands,
	endNote,
	changeNotes,
	clock,
	missingResult,
}
