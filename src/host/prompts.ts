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

import type { ImageBlock, UserBlock } from '../common/blocks.ts'
import type { InboxItem } from '../common/inbox.ts'
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
// at once, whatever the state (`from`: the session that sent it).
function submit(id: string, text: string, command?: string, queue = false, from?: string): string | undefined {
	let call = commands.parse(text)
	if (call) return slash.command(id, text, call, command, from)
	let state = status.stateOf(id)
	if (states.busy(state) || (queue && state.type !== 'idle')) {
		let record: Omit<HistoryRecord & { type: 'inbox' }, 'ts'> = { type: 'inbox', id: command ?? crypto.randomUUID(), text }
		if (queue) record.queue = true
		history.append(id, record)
		host.broadcast(id, { type: 'inbox', sessionId: id, inbox: status.inboxOf(id) })
		return
	}
	let refused = status.transition(id, { type: 'submit' })
	if (refused) return refused
	let steering = status.inboxOf(id).filter((m) => !m.queue)
	if (!steering.length) {
		let { blocks } = blobs.resolve(id, [text])
		history.submit(id, blocks, command)
		return void turns.start(id, prompts.texts(blocks)[0], undefined, prompts.images(blocks))
	}
	prompts.deliver(id, steering, text, command)
	turns.start(id)
}

// An edit of the last prompt. If only reading happened since it, the
// edit replaces it and the turn runs again as if it had been written
// that way; otherwise, or while the turn is still busy, it is a prompt
// like any other. The edit is of the prompt's last text: messages it
// delivered from the inbox before that stay.
function amend(id: string, text: string, command?: string): string | undefined {
	let records = history.readSync(id)
	let at = replay.lastPrompt(records)
	let old = records[at]
	if (states.busy(status.stateOf(id, records)) || old?.type !== 'user' || !prompts.harmless(records.slice(at + 1))) return prompts.submit(id, text, command)
	let refused = status.transition(id, { type: 'submit' })
	if (refused) return refused
	let texts = prompts.texts(old.blocks)
	texts[texts.length - 1] = text
	// Images stay while their markers do: the texts are resolved again.
	let { blocks } = blobs.resolve(id, texts)
	let record: Omit<HistoryRecord & { type: 'user' }, 'ts'> = { type: 'user', blocks, replaces: true }
	if (command !== undefined) record.command = command
	history.append(id, record)
	host.broadcast(id, prompts.promptEvent(id, blocks, true))
	turns.start(id)
}

// Whether the records after a prompt leave the world as it was: no
// tool call except read-only ones (tools.readOnly).
function harmless(records: HistoryRecord[]): boolean {
	return records.every((r) => r.type !== 'assistant' || r.block.type !== 'tool_call' || tools.readOnly(r.block.name))
}

// After a command's question closed on an idle session: runs what was
// sent meanwhile, steering first, as submit and next would have.
function drain(id: string): void {
	if (status.stateOf(id).type !== 'idle') return
	let steering = status.inboxOf(id).filter((m) => !m.queue)
	if (!steering.length) return prompts.next(id)
	if (status.transition(id, { type: 'submit' })) return
	prompts.deliver(id, steering)
	turns.start(id)
}

// Records inbox messages (and a new prompt `text`) as one prompt, its
// attachment markers resolved (blobs.resolve), and tells followers: a
// `prompt` event, or with `quiet` nothing, as the caller's turn-start
// carries it. Returns the prompt's blocks.
function deliver(id: string, items: InboxItem[], text?: string, command?: string, quiet = false): UserBlock[] {
	let texts = items.map((m) => m.text)
	if (text !== undefined) texts.push(text)
	let { blocks } = blobs.resolve(id, texts)
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
	turns.start(id, prompts.texts(list)[0], undefined, prompts.images(list))
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
	harmless,
	drain,
	deliver,
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
