// What the user sends into a session: prompts, edits, continue and
// answers, and the inbox they wait in.
//
// Sending while a turn is busy puts the message in the session inbox
// (src/common/inbox.ts), durable in history: steering messages go to
// the model together after immediately canceling its active round.
// Queued and advisory messages never cancel a round; queued ones run
// as turns of their own once it has completed.
//
// An edit of the last prompt (submit with `amend`, sent after the
// client paused the turn) replaces that prompt when nothing with side
// effects ran since: a new record that supersedes it and its turn for the
// provider (replay.current), history staying append-only. Otherwise it
// is sent on top like any prompt.

import type { ImageBlock, Sender, UserBlock, UserText } from '../common/blocks.ts'
import { inbox, type InboxItem } from '../common/inbox.ts'
import { forms, type Answers } from '../common/forms.ts'
import type { Event } from '../common/protocol.ts'
import { replay, type HistoryRecord } from '../common/replay.ts'
import { states } from '../common/states.ts'
import { blobs } from './blobs.ts'
import { commands } from './commands.ts'
import { diag } from './diag.ts'
import { drafts } from './drafts.ts'
import { history } from './history.ts'
import { naming } from './naming.ts'
import { tools } from './tools.ts'
import { host } from './host.ts'
import { jobs } from './jobs.ts'
import { slash } from './slash.ts'
import { status } from './status.ts'
import { statusUsage } from './status-usage.ts'
import { subagents } from './subagents.ts'
import { notify } from './notify.ts'
import { queueEdits } from './queue-edits.ts'
import { turns } from './turns.ts'

// Returns why the submit is refused, if it is. `command` is the
// client's id for it, kept with the prompt (or inbox message) so a
// later host can tell a resend. While a turn streams the message waits
// in the inbox; `queue` also makes it wait for a paused or failed
// turn to finish. Otherwise it starts a turn, delivering any steering
// messages still waiting (a paused turn's) first. A slash command runs
// at once, whatever the state.
//
// `sender`: another session sent it (task rj), set by the host from the
// sending session, never by a client. Such a message never ends a
// pause or a failure the user has to see to: it waits in the inbox
// unless the session is idle, where it runs as a turn of its own and
// so gets full attention (no longer advisory).
//
// `nextRound` (the terminal's plain Enter, task csn): a steer that
// leaves the stream and running tools alone; the turn delivers it before
// its next request.
function submit(id: string, text: string, command?: string, queue = false, sender?: Sender, nextRound = false): string | undefined {
	let call = commands.parse(text)
	// A command (/model, /pause) is not a prompt: the tab stays the parent's.
	if (!call && sender?.from === undefined && sender?.origin !== 'model') subagents.promote(id)
	if (call) return slash.command(id, text, call, command, sender?.from, undefined, sender?.origin, sender)
	let state = status.stateOf(id)
	let interrupt = !queue && sender?.advisory !== true
	// Queued messages still waiting (one is being edited) go first.
	let behind = queue && status.inboxOf(id).some((m) => m.queue)
	// After an asking turn (task nd6), a queued message waits for the reply's turn.
	if (behind || (queue && notify.asked(id)) || turns.state.running.has(id) || states.busy(state) || ((queue || sender?.from !== undefined || sender?.origin === 'model') && state.type !== 'idle')) {
		let record: Omit<HistoryRecord & { type: 'inbox' }, 'ts'> = { type: 'inbox', id: command ?? crypto.randomUUID(), text }
		if (queue) record.queue = true
		if (sender) Object.assign(record, inbox.sender(queue ? { ...sender, advisory: undefined } : sender))
		history.append(id, record)
		// A steer swaps in a fresh controller and aborts the old one: the
		// turn goes on with the inbox once the old work has settled. A
		// running call flagged unsafeToStop defers it until the call ends
		// (task ker); after Escape nothing runs on to protect.
		let running = turns.state.running.get(id)
		if (interrupt && running) {
			// Even just after Escape, while the turn still settles: it goes on.
			status.transition(id, { type: 'submit' })
			if (nextRound) {
				// Stopped by Escape: nothing runs on, so it steers as usual.
				if (running.controller.signal.aborted) prompts.interrupt(running)
			} else if (running.unsafe && !running.controller.signal.aborted) running.steered = true
			else prompts.interrupt(running)
		}
		host.broadcast(id, { type: 'inbox', sessionId: id, inbox: status.inboxOf(id) })
		return
	}
	let refused = status.transition(id, { type: 'submit' })
	if (refused) return refused
	let steering = status.inboxOf(id).filter((m) => !m.queue)
	let own = { ...inbox.sender(sender ?? {}), advisory: undefined }
	if (!steering.length) {
		let list = prompts.blocks(id, [{ text, ...own }])
		let record = history.submit(id, list, command) as HistoryRecord & { type: 'user' }
		return void turns.start(id, prompts.texts(list)[0], undefined, prompts.images(list), { ...record, sender: prompts.senders(list)[0] })
	}
	prompts.deliver(id, steering, { text, ...own }, command)
	turns.start(id)
}

// Steers `running`: a fresh controller for the turn to go on with, the
// old one aborted so its pending work settles.
function interrupt(running: { controller: AbortController }): void {
	let old = running.controller
	running.controller = new AbortController()
	old.abort(jobs.steered)
}

// A prompt's blocks from its texts, each keeping who sent it, attachment
// markers resolved (blobs.resolve).
function blocksOf(id: string, parts: (Sender & { text: string })[]): UserBlock[] {
	let { blocks } = blobs.resolve(id, parts.map((p) => p.text))
	return blocks.map((b, i) => (b.type === 'text' && parts[i] ? { ...b, ...inbox.sender(parts[i]) } : b))
}

// Who sent each text of a prompt's blocks.
function senders(list: UserBlock[]): Sender[] {
	return list.flatMap((b) => (b.type === 'text' ? [inbox.sender(b)] : []))
}

// An edit of the last prompt. If only reading happened since it, the
// edit replaces it and the turn runs again as if it had been written
// that way; otherwise, or while the turn is still busy, it is a prompt
// like any other. The edit is of the human's last text in the prompt:
// the other texts it delivered from the inbox stay. A prompt with no
// text of the human's is not theirs to edit: the edit goes on top.
function amend(id: string, text: string, command?: string): string | undefined {
	subagents.promote(id)
	let records = history.readSync(id)
	let at = replay.lastPrompt(records)
	let old = records[at]
	let parts = old?.type === 'user' ? old.blocks.filter((b): b is UserText => b.type === 'text') : []
	let mine = parts.findLastIndex((b) => b.from === undefined && b.origin !== 'model')
	if (states.busy(status.stateOf(id, records)) || mine < 0 || !prompts.harmless(records.slice(at + 1))) return prompts.submit(id, text, command)
	let refused = status.transition(id, { type: 'submit' })
	if (refused) return refused
	parts[mine] = { type: 'text', text }
	// Images stay while their markers do: the texts are resolved again.
	let blocks = prompts.blocks(id, parts)
	let record: Omit<HistoryRecord & { type: 'user' }, 'ts'> = { type: 'user', blocks, replaces: true }
	if (command !== undefined) record.command = command
	naming.prepare(id, record as Extract<HistoryRecord, { type: 'user' }>)
	host.broadcast(id, prompts.promptEvent(id, history.append(id, record) as HistoryRecord & { type: 'user' }))
	turns.start(id)
}

// An edit of inbox message `message`. While it waits, the edit takes
// its place (the model never saw it); one that became a slash command
// takes it out and runs. Delivered meanwhile, it is an edit of the last
// prompt (prompts.amend). Messages from other sessions are not the
// user's to edit.
function edit(id: string, message: string, text: string, command?: string, held = false): string | undefined {
	let waiting = status.inboxOf(id).find((m) => m.id === message)
	if (waiting?.from !== undefined || waiting?.origin === 'model') return 'that message was not sent by the human'
	if (held && !waiting) return 'that human message is no longer queued'
	let call = held ? undefined : commands.parse(text)
	if (!waiting) return call ? prompts.submit(id, text, command) : prompts.amend(id, text, command)
	let refused = call ? slash.command(id, text, call, command) : undefined
	if (refused) return refused
	let record: Omit<HistoryRecord & { type: 'inbox' }, 'ts'> = { type: 'inbox', id: message, text }
	if (call) record.withdrawn = true
	else if (waiting.queue) record.queue = true
	if (command !== undefined) record.command = command
	history.append(id, record)
	host.broadcast(id, { type: 'inbox', sessionId: id, inbox: status.inboxOf(id) })
}

// Whether the records after a prompt leave the world as it was: no
// tool call except read-only ones (tools.readOnly).
function harmless(records: HistoryRecord[]): boolean {
	return records.every((r) => r.type !== 'assistant' || r.block.type !== 'tool_call' || tools.readOnly(r.block.name))
}

// Records inbox messages (and a new prompt `extra`) as one prompt, its
// attachment markers resolved (blobs.resolve), and tells followers: a
// `prompt` event, or with `quiet` nothing, as the caller's turn-start
// carries it. Returns the prompt's record.
function deliver(id: string, items: InboxItem[], extra?: Sender & { text: string }, command?: string, quiet = false): HistoryRecord & { type: 'user' } {
	// The invariant behind every dequeue: a locked message never leaves.
	let hold = queueEdits.held(id)
	if (hold !== undefined && items.some((m) => m.id === hold)) throw new Error(`queued message ${hold} is being edited; it cannot be delivered`)
	let parts = items.map((m) => ({ ...m, ...inbox.provenance(m) }))
	let blocks = prompts.blocks(id, extra ? [...parts, extra] : parts)
	let record: Omit<HistoryRecord & { type: 'user' }, 'ts'> = { type: 'user', blocks, inbox: items.map((m) => m.id) }
	if (command !== undefined) record.command = command
	if (items.length === 1 && items[0]!.queue) {
		record.queued = true
		record.command ??= items[0]!.id
	}
	naming.prepare(id, record as Extract<HistoryRecord, { type: 'user' }>)
	let written = history.append(id, record) as HistoryRecord & { type: 'user' }
	host.broadcast(id, { type: 'inbox', sessionId: id, inbox: status.inboxOf(id) })
	if (!quiet) host.broadcast(id, prompts.promptEvent(id, written))
	return written
}

function texts(list: UserBlock[]): string[] {
	return list.flatMap((b) => (b.type === 'text' ? [b.text] : []))
}

function images(list: UserBlock[]): ImageBlock[] {
	return list.filter((b): b is ImageBlock => b.type === 'image')
}

// The `prompt` event telling followers of a prompt record.
function promptEvent(id: string, record: HistoryRecord & { type: 'user' }): Event {
	let event: Event & { type: 'prompt' } = { type: 'prompt', sessionId: id, texts: prompts.texts(record.blocks) }
	let who = prompts.senders(record.blocks)
	if (who.some((s) => Object.keys(s).length)) event.senders = who
	let shown = prompts.images(record.blocks)
	if (shown.length) event.images = shown
	if (record.queued) event.queued = true
	if (record.replaces) event.replaces = true
	if (record.n !== undefined) event.n = record.n
	if (record.command !== undefined) event.command = record.command
	event.ts = record.ts
	return event
}

// Before a request: delivers the steering messages waiting, if any.
function steer(id: string): void {
	let steering = status.inboxOf(id).filter((m) => !m.queue)
	if (steering.length) prompts.deliver(id, steering)
}

// After a completed turn: runs the oldest queued message, if any. One
// being edited waits, and the ones behind it too (queueEdits.release).
// A turn that ended with <question> waits for the user's reply first
// (task nd6); queued messages run after a final answer.
function next(id: string): void {
	let queued = status.inboxOf(id).find((m) => m.queue)
	if (!queued || queued.id === queueEdits.held(id) || notify.asked(id) || status.transition(id, { type: 'submit' })) return
	let record = prompts.deliver(id, [queued], undefined, undefined, true)
	turns.start(id, prompts.texts(record.blocks)[0], undefined, prompts.images(record.blocks), { ...record, sender: prompts.senders(record.blocks)[0] })
}

// /queue next: the oldest queued message goes now. In a busy turn it
// becomes a steering message for the next round; otherwise it runs as
// a fresh turn, even if paused. One being edited goes when the edit ends.
function queueNext(id: string): { say?: string; error?: string } {
	let item = status.inboxOf(id).find((m) => m.queue)
	if (!item) return { say: 'queue is empty' }
	if (queueEdits.deferNext(id)) return { say: 'The next queued message is being edited. It is sent when the edit is saved or canceled.' }
	if (states.busy(status.stateOf(id))) {
		// Editing this inbox id preserves its place, sender and provenance.
		history.append(id, { type: 'inbox', id: item.id, text: item.text, ...(item.from ? { from: item.from, label: item.label } : {}) })
		host.broadcast(id, { type: 'inbox', sessionId: id, inbox: status.inboxOf(id) })
		return { say: 'sending the next queued message now' }
	}
	let refused = status.transition(id, { type: 'submit' })
	if (refused) return { error: refused }
	let record = prompts.deliver(id, [item], undefined, undefined, true)
	turns.start(id, prompts.texts(record.blocks)[0], undefined, prompts.images(record.blocks), { ...record, sender: prompts.senders(record.blocks)[0] })
	return { say: 'running the next queued message' }
}

// After a submit: the draft it was typed in is sent, so it clears
// (drafts.sent), and followers hear it with the submit's id.
function sent(id: string, text: string, command?: string): void {
	try {
		prompts.draft(id, drafts.sent(id, text), command)
	} catch (e: any) {
		diag.log(`draft ${id}: ${e?.message ?? e}`)
	}
}

// Tells followers the session's draft changed (if it did), naming the
// command that changed it.
function draft(id: string, changed: ReturnType<typeof drafts.get> | undefined, command?: string): void {
	if (!changed) return
	let event: Event = { type: 'draft', sessionId: id, draft: changed }
	if (command !== undefined) event.command = command
	host.broadcast(id, event)
}

// Continue: a paused turn goes on, a failed one retries.
function resume(id: string): string | undefined {
	// Enter on a waiting turn: re-read the skipped accounts, then retry now.
	let running = turns.state.running.get(id)
	if (running?.rewait && status.stateOf(id).type === 'retrying') {
		void statusUsage.recheck(running.provider, true).then(() => running.rewait?.abort())
		return
	}
	let refused = status.transition(id, { type: 'continue' })
	if (refused) return refused
	history.append(id, { type: 'continue' })
	turns.start(id)
}

// The first valid answer to the open question: recorded (secrets only
// named), shown, and the turn or command that asked runs again with it.
// Returns
// why it is refused: not the open question (someone answered first),
// or answers that don't fit the form.
function reply(id: string, question: string, answers: Answers): string | undefined {
	let open = forms.open(history.readSync(id))
	// A command's question may be open beside a turn blocked on login.
	if (!open || open.id !== question || (!open.from && turns.state.running.has(id))) return 'that question is not open (answered already?)'
	let problem = forms.check(open.form, answers)
	if (problem) return problem
	if (open.from) {
		problem = commands.all().get(open.from.command)?.checkAnswers?.(open.from.args, answers)
		if (problem) return problem
	}
	let kept = forms.redact(open.form, answers)
	if (open.from) {
		// Beside the turn: its state stays as it is.
		history.append(id, { type: 'answer', question, ...kept })
		host.broadcast(id, { type: 'answer', sessionId: id, question, ...kept })
		void slash.runCommand(id, open.from.command, open.from.args, answers)
		return
	}
	let refused = status.transition(id, { type: 'answer' })
	if (refused) return refused
	history.append(id, { type: 'answer', question, ...kept })
	host.broadcast(id, { type: 'answer', sessionId: id, question, ...kept })
	turns.start(id, undefined, answers)
}

export const prompts = {
	submit,
	interrupt,
	amend,
	edit,
	harmless,
	deliver,
	blocks: blocksOf,
	senders,
	texts,
	images,
	promptEvent,
	steer,
	next,
	queueNext,
	sent,
	draft,
	resume,
	reply,
}
