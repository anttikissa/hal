// What the user sends into a session: prompts, edits, continue and
// answers, and the inbox they wait in.
//
// Sending while a turn is busy puts the message in the session inbox
// (src/common/inbox.ts), durable in history: steering messages go to
// the model together before the turn's next request, queued ones run as
// turns of their own once it has completed.
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
import { tools } from './tools.ts'
import { host } from './host.ts'
import { slash } from './slash.ts'
import { status } from './status.ts'
import { turns } from './turns.ts'

// Returns why the submit is refused, if it is. `command` is the
// client's id for it, kept with the prompt (or inbox message) so a
// later host can tell a resend. While the session is busy the message
// waits in the inbox; `queue` also makes it wait for a paused or failed
// turn to finish. Otherwise it starts a turn, delivering any steering
// messages still waiting (a paused turn's) first. A slash command runs
// at once, whatever the state.
//
// `sender`: another session sent it (task rj), set by the host from the
// sending session, never by a client. Such a message never ends a
// pause or a failure the user has to see to: it waits in the inbox
// unless the session is idle, where it runs as a turn of its own and
// so gets full attention (no longer advisory).
function submit(id: string, text: string, command?: string, queue = false, sender?: Sender): string | undefined {
	let call = commands.parse(text)
	if (call) return slash.command(id, text, call, command, sender?.from)
	let state = status.stateOf(id)
	if (states.busy(state) || ((queue || sender?.from !== undefined) && state.type !== 'idle')) {
		let record: Omit<HistoryRecord & { type: 'inbox' }, 'ts'> = { type: 'inbox', id: command ?? crypto.randomUUID(), text }
		if (queue) record.queue = true
		if (sender) Object.assign(record, inbox.sender(queue ? { ...sender, advisory: undefined } : sender))
		history.append(id, record)
		host.broadcast(id, { type: 'inbox', sessionId: id, inbox: status.inboxOf(id) })
		return
	}
	let refused = status.transition(id, { type: 'submit' })
	if (refused) return refused
	let steering = status.inboxOf(id).filter((m) => !m.queue)
	let own = { ...inbox.sender(sender ?? {}), advisory: undefined }
	if (!steering.length) {
		let list = prompts.blocks(id, [{ text, ...own }])
		history.submit(id, list, command)
		return void turns.start(id, prompts.texts(list)[0], undefined, prompts.images(list), prompts.senders(list)[0])
	}
	prompts.deliver(id, steering, { text, ...own }, command)
	turns.start(id)
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
	let records = history.readSync(id)
	let at = replay.lastPrompt(records)
	let old = records[at]
	let parts = old?.type === 'user' ? old.blocks.filter((b): b is UserText => b.type === 'text') : []
	let mine = parts.findLastIndex((b) => b.from === undefined)
	if (states.busy(status.stateOf(id, records)) || mine < 0 || !prompts.harmless(records.slice(at + 1))) return prompts.submit(id, text, command)
	let refused = status.transition(id, { type: 'submit' })
	if (refused) return refused
	parts[mine] = { type: 'text', text }
	// Images stay while their markers do: the texts are resolved again.
	let blocks = prompts.blocks(id, parts)
	let record: Omit<HistoryRecord & { type: 'user' }, 'ts'> = { type: 'user', blocks, replaces: true }
	if (command !== undefined) record.command = command
	history.append(id, record)
	host.broadcast(id, prompts.promptEvent(id, blocks, true))
	turns.start(id)
}

// An edit of inbox message `message`. While it waits, the edit takes
// its place (the model never saw it); one that became a slash command
// takes it out and runs. Delivered meanwhile, it is an edit of the last
// prompt (prompts.amend). Messages from other sessions are not the
// user's to edit.
function edit(id: string, message: string, text: string, command?: string): string | undefined {
	let waiting = status.inboxOf(id).find((m) => m.id === message)
	if (waiting?.from !== undefined) return 'that message was sent by another session'
	let call = commands.parse(text)
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

// After a command's question closed on an idle session: runs what was
// sent meanwhile, steering first, as submit and next would have. A
// turn of their own: advisory messages get full attention.
function drain(id: string): void {
	if (status.stateOf(id).type !== 'idle') return
	let steering = status.inboxOf(id).filter((m) => !m.queue)
	if (!steering.length) return prompts.next(id)
	if (status.transition(id, { type: 'submit' })) return
	prompts.deliver(id, steering.map((m) => ({ ...m, advisory: undefined })))
	turns.start(id)
}

// Records inbox messages (and a new prompt `extra`) as one prompt, its
// attachment markers resolved (blobs.resolve), and tells followers: a
// `prompt` event, or with `quiet` nothing, as the caller's turn-start
// carries it. Returns the prompt's blocks.
function deliver(id: string, items: InboxItem[], extra?: Sender & { text: string }, command?: string, quiet = false): UserBlock[] {
	let blocks = prompts.blocks(id, extra ? [...items, extra] : items)
	let record: Omit<HistoryRecord & { type: 'user' }, 'ts'> = { type: 'user', blocks, inbox: items.map((m) => m.id) }
	if (command !== undefined) record.command = command
	history.append(id, record)
	host.broadcast(id, { type: 'inbox', sessionId: id, inbox: status.inboxOf(id) })
	if (!quiet) host.broadcast(id, prompts.promptEvent(id, blocks))
	return blocks
}

function texts(list: UserBlock[]): string[] {
	return list.flatMap((b) => (b.type === 'text' ? [b.text] : []))
}

function images(list: UserBlock[]): ImageBlock[] {
	return list.filter((b): b is ImageBlock => b.type === 'image')
}

// The `prompt` event telling followers of a prompt record's blocks.
function promptEvent(id: string, list: UserBlock[], replaces = false): Event {
	let event: Event & { type: 'prompt' } = { type: 'prompt', sessionId: id, texts: prompts.texts(list) }
	let who = prompts.senders(list)
	if (who.some((s) => s.from !== undefined)) event.senders = who
	let shown = prompts.images(list)
	if (shown.length) event.images = shown
	if (replaces) event.replaces = true
	return event
}

// Before a request: delivers the steering messages waiting, if any.
function steer(id: string): void {
	let steering = status.inboxOf(id).filter((m) => !m.queue)
	if (steering.length) prompts.deliver(id, steering)
}

// After a completed turn: runs the oldest queued message, if any.
function next(id: string): void {
	let queued = status.inboxOf(id).find((m) => m.queue)
	if (!queued || status.transition(id, { type: 'submit' })) return
	let list = prompts.deliver(id, [queued], undefined, undefined, true)
	turns.start(id, prompts.texts(list)[0], undefined, prompts.images(list), prompts.senders(list)[0])
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
	if (!open || open.id !== question || turns.state.running.has(id)) return 'that question is not open (answered already?)'
	let problem = forms.check(open.form, answers)
	if (problem) return problem
	let kept = forms.redact(open.form, answers)
	if (open.from) {
		let { command: name, args } = open.from
		let before = status.stateOf(id)
		history.append(id, { type: 'answer', question, ...kept })
		host.broadcast(id, { type: 'answer', sessionId: id, question, ...kept })
		status.settle(id, before)
		void slash.runCommand(id, name, args, answers).then(() => prompts.drain(id))
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
	amend,
	edit,
	harmless,
	drain,
	deliver,
	blocks: blocksOf,
	senders,
	texts,
	images,
	promptEvent,
	steer,
	next,
	sent,
	draft,
	resume,
	reply,
}
