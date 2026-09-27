// The transcript every client shows: one pure fold of a session snapshot
// and the live events after it (src/common/protocol.ts). A client that
// followed the events and one that connected later end up with equal
// transcripts. This is display state only; provider input is rebuilt
// from history on the host, never from here, so items drop what only a
// provider needs (thinking signatures, their provider).

import { blocks, type AssistantBlock, type ToolResultBlock, type Usage } from './blocks.ts'
import type { Answers, Form } from './forms.ts'
import type { InboxItem } from './inbox.ts'
import type { Event, LiveTurn, Snapshot, TurnStatus } from './protocol.ts'
import { replay, type HistoryRecord } from './replay.ts'
import type { SessionMeta } from './session.ts'
import type { SessionState } from './states.ts'

export type Item =
	| { type: 'prompt'; text: string }
	| { type: 'text'; text: string }
	| { type: 'thinking'; text: string }
	| { type: 'tool'; id: string; name: string; input: Record<string, unknown> }
	| { type: 'tool-result'; id: string; output: string; isError?: boolean }
	| { type: 'turn-end'; status: TurnStatus; usage?: Usage; error?: string }
	// A durable question; with `answers` once answered (secrets only named).
	// `cancelled`: dismissed with Escape (a command's question).
	| { type: 'question'; id: string; form: Form; answers?: Answers; secrets?: string[]; cancelled?: true }
	// A slash command as typed; `from`: the session that sent it.
	| { type: 'command'; text: string; from?: string }
	// What a command said.
	| { type: 'output'; text: string; error?: true }

export type Transcript = {
	meta: SessionMeta
	// The session's state, as the host last said (src/common/states.ts).
	state: SessionState
	// Messages waiting for the turn (src/common/inbox.ts); always shown.
	inbox: InboxItem[]
	// Everything to show, in order, including the running turn's output.
	items: Item[]
	// Where the last prompt's items start: an edit of it replaces them
	// and everything after.
	prompt?: number
	// The running turn: items from `start` on are its output so far, and
	// `turn` is the raw fold they are drawn from.
	live?: { start: number; turn: LiveTurn }
}

// Display items for assistant blocks. Empty thinking (a bare signature,
// redacted reasoning) shows nothing.
function blockItems(list: AssistantBlock[]): Item[] {
	let out: Item[] = []
	for (let b of list) {
		if (b.type === 'tool_call') out.push({ type: 'tool', id: b.id, name: b.name, input: b.input })
		else if (b.text) out.push({ type: b.type, text: b.text })
	}
	return out
}

function resultItem(b: ToolResultBlock): Item {
	let item: Item = { type: 'tool-result', id: b.id, output: b.output }
	if (b.isError) item.isError = true
	return item
}

// Display items for one history record.
function recordItems(r: HistoryRecord): Item[] {
	if (r.type === 'assistant') return transcript.blockItems([r.block])
	if (r.type === 'continue' || r.type === 'inbox' || r.type === 'answer' || r.type === 'change') return []
	if (r.type === 'question') return [{ type: 'question', id: r.id, form: r.form }]
	if (r.type === 'command' || r.type === 'output') return [transcript.aside(r)]
	if (r.type === 'user') return r.blocks.map((b): Item => (b.type === 'text' ? { type: 'prompt', text: b.text } : transcript.resultItem(b)))
	return [transcript.endItem(r)]
}

// A turn end as shown, the same from a record or a live turn-end event.
function endItem(end: { status: TurnStatus; usage?: Usage; error?: string }): Item {
	let item: Item = { type: 'turn-end', status: end.status }
	if (end.usage && Object.keys(end.usage).length) item.usage = end.usage
	if (end.error !== undefined) item.error = end.error
	return item
}

// Items with question `answer.question` shown answered.
function answered(items: Item[], answer: { question: string; answers: Answers; secrets?: string[]; cancelled?: true }): Item[] {
	return items.map((item) => {
		if (item.type !== 'question' || item.id !== answer.question) return item
		let done: Item = { ...item, answers: answer.answers }
		if (answer.secrets) done.secrets = answer.secrets
		if (answer.cancelled) done.cancelled = true
		return done
	})
}

// A command or its output as shown, from a record or an event.
function aside(r: { type: 'command'; text: string; from?: string } | { type: 'output'; text: string; error?: true }): Item {
	if (r.type === 'command') return r.from === undefined ? { type: 'command', text: r.text } : { type: 'command', text: r.text, from: r.from }
	return r.error ? { type: 'output', text: r.text, error: true } : { type: 'output', text: r.text }
}

// The question waiting for an answer from this transcript, if any.
function question(t: Transcript | undefined): (Item & { type: 'question' }) | undefined {
	if (t?.state.type !== 'blocked' || t.state.reason !== 'question') return undefined
	let last = t.items.findLast((item) => item.type === 'question')
	return last?.type === 'question' && !last.answers ? last : undefined
}

function fromSnapshot(snapshot: Snapshot): Transcript {
	let items: Item[] = []
	let prompt: number | undefined
	for (let r of replay.current(snapshot.history)) {
		if (replay.isPrompt(r)) prompt = items.length
		items = r.type === 'answer' ? transcript.answered(items, r) : [...items, ...transcript.recordItems(r)]
	}
	let t: Transcript = { meta: { ...snapshot.meta }, state: snapshot.state, inbox: snapshot.inbox ?? [], items }
	if (prompt !== undefined) t.prompt = prompt
	if (snapshot.turn) {
		let turn = transcript.copyTurn(snapshot.turn)
		t.live = { start: items.length, turn }
		t.items = [...items, ...transcript.blockItems(turn.blocks)]
	}
	return t
}

// A copy that blocks.apply may mutate without touching the original:
// apply only ever changes the last block and the usage.
function copyTurn(turn: LiveTurn): LiveTurn {
	let list = turn.blocks.slice()
	let last = list.at(-1)
	if (last) list[list.length - 1] = { ...last }
	return { provider: turn.provider, blocks: list, usage: { ...turn.usage } }
}

// The transcript after `event`; the same object if the event does not
// concern it. Events before the first snapshot are ignored.
function fold(t: Transcript | undefined, event: Event): Transcript | undefined {
	if (event.type === 'snapshot') return t && t.meta.id !== event.sessionId ? t : transcript.fromSnapshot(event.snapshot)
	if (!t || event.type === 'rejected' || event.type === 'warning' || event.type === 'ack' || event.type === 'draft' || event.sessionId !== t.meta.id) return t
	if (event.type === 'state') return { ...t, state: event.state }
	if (event.type === 'inbox') return { ...t, inbox: event.inbox }
	if (event.type === 'answer') return { ...t, items: transcript.answered(t.items, event) }
	if (event.type === 'meta') return { ...t, meta: { ...event.meta } }
	if (event.type === 'completions') return t
	if (event.type === 'command' || event.type === 'output') {
		// Beside a running turn: before its live output, which is redrawn.
		let item = transcript.aside(event)
		if (!t.live) return { ...t, items: [...t.items, item] }
		let at = t.live.start
		return { ...t, items: [...t.items.slice(0, at), item, ...t.items.slice(at)], live: { start: at + 1, turn: t.live.turn } }
	}
	if (event.type === 'turn-start') {
		if (event.prompt === undefined) return { ...t, live: { start: t.items.length, turn: { provider: event.provider, blocks: [], usage: {} } } }
		let items: Item[] = [...t.items, { type: 'prompt', text: event.prompt }]
		return { ...t, items, prompt: t.items.length, live: { start: items.length, turn: { provider: event.provider, blocks: [], usage: {} } } }
	}
	let question: Item | undefined = event.type === 'question' ? { type: 'question', id: event.id, form: event.form } : undefined
	// A turn left unfinished by another host ends without running here.
	if (!t.live) {
		if (event.type === 'turn-end') return { ...t, items: [...t.items, transcript.endItem(event)] }
		if (event.type === 'prompt') return transcript.prompted(t, t.items, event)
		return question ? { ...t, items: [...t.items, question] } : t
	}
	let settled = t.items.slice(0, t.live.start)
	if (event.type === 'prompt') {
		// The round's blocks are in history before the prompt.
		let next = transcript.prompted(t, [...settled, ...transcript.blockItems(t.live.turn.blocks)], event)
		return { ...next, live: { start: next.items.length, turn: { provider: t.live.turn.provider, blocks: [], usage: {} } } }
	}
	if (event.type === 'stream') {
		let turn = transcript.copyTurn(t.live.turn)
		blocks.apply(turn, event.event)
		return { ...t, items: [...settled, ...transcript.blockItems(turn.blocks)], live: { start: t.live.start, turn } }
	}
	if (event.type === 'tool-results') {
		// The round's blocks are in history now; the next round starts empty.
		let items = [...settled, ...transcript.blockItems(t.live.turn.blocks), ...event.results.map((b) => transcript.resultItem(b))]
		return { ...t, items, live: { start: items.length, turn: { provider: t.live.turn.provider, blocks: [], usage: {} } } }
	}
	// Asking stops the running turn: its output is in history.
	let end = question ?? transcript.endItem(event as Event & { type: 'turn-end' })
	let { live: _live, ...rest } = t
	return { ...rest, items: [...settled, ...transcript.blockItems(t.live.turn.blocks), end] }
}

// After `items`, a prompt event's texts; an edit (`replaces`) takes
// the place of the last prompt and everything after it.
function prompted(t: Transcript, items: Item[], event: Event & { type: 'prompt' }): Transcript {
	let keep = event.replaces && t.prompt !== undefined ? items.slice(0, t.prompt) : items
	let { live: _live, ...rest } = t
	return { ...rest, items: [...keep, ...event.texts.map((text): Item => ({ type: 'prompt', text }))], prompt: keep.length }
}

// Where the history a client got in a snapshot ends (an index into
// items) and when it was last written. Clients mark that spot, so an old
// error redrawn at startup does not look like a new one. Kept out of the
// transcript: a client that followed the events has no such spot.
export type Resumed = { at: number; last: string }

function resumed(snapshot: Snapshot, t: Transcript): Resumed | undefined {
	let last = snapshot.history.at(-1)
	return last && { at: t.live?.start ?? t.items.length, last: last.ts }
}

// "resumed · last turn 00:51", with the date when it was not today.
function resumedLabel(r: Resumed, now = new Date()): string {
	return `resumed · last turn ${replay.clock(r.last, now.toISOString())}`
}

export const transcript = { blockItems, resultItem, recordItems, endItem, aside, answered, question, fromSnapshot, copyTurn, fold, prompted, resumed, resumedLabel }
