// The transcript every client shows: one pure fold of a session snapshot
// and the live events after it (src/common/protocol.ts). A client that
// followed the events and one that connected later end up with equal
// transcripts. This is display state only; provider input is rebuilt
// from history on the host, never from here, so items drop what only a
// provider needs (thinking signatures, their provider).

import { blocks, type AssistantBlock, type Usage } from './blocks.ts'
import type { Event, LiveTurn, Snapshot, TurnStatus } from './protocol.ts'
import type { HistoryRecord } from './replay.ts'
import type { SessionMeta } from './session.ts'

export type Item =
	| { type: 'prompt'; text: string }
	| { type: 'text'; text: string }
	| { type: 'thinking'; text: string }
	| { type: 'tool'; id: string; name: string; input: Record<string, unknown> }
	| { type: 'turn-end'; status: TurnStatus; usage?: Usage; error?: string }

export type Transcript = {
	meta: SessionMeta
	// Everything to show, in order, including the running turn's output.
	items: Item[]
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

// Display items for one history record. Prompts show their text; tool
// results are not shown yet.
function recordItems(r: HistoryRecord): Item[] {
	if (r.type === 'assistant') return transcript.blockItems([r.block])
	if (r.type === 'user') return r.blocks.flatMap((b): Item[] => (b.type === 'text' ? [{ type: 'prompt', text: b.text }] : []))
	return [transcript.endItem(r)]
}

// A turn end as shown, the same from a record or a live turn-end event.
function endItem(end: { status: TurnStatus; usage?: Usage; error?: string }): Item {
	let item: Item = { type: 'turn-end', status: end.status }
	if (end.usage && Object.keys(end.usage).length) item.usage = end.usage
	if (end.error !== undefined) item.error = end.error
	return item
}

function fromSnapshot(snapshot: Snapshot): Transcript {
	let items = snapshot.history.flatMap((r) => transcript.recordItems(r))
	let t: Transcript = { meta: { ...snapshot.meta }, items }
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
	if (!t || event.type === 'rejected' || event.sessionId !== t.meta.id) return t
	if (event.type === 'turn-start') {
		let items: Item[] = [...t.items, { type: 'prompt', text: event.prompt }]
		return { meta: t.meta, items, live: { start: items.length, turn: { provider: event.provider, blocks: [], usage: {} } } }
	}
	if (!t.live) return t
	let settled = t.items.slice(0, t.live.start)
	if (event.type === 'stream') {
		let turn = transcript.copyTurn(t.live.turn)
		blocks.apply(turn, event.event)
		return { meta: t.meta, items: [...settled, ...transcript.blockItems(turn.blocks)], live: { start: t.live.start, turn } }
	}
	let end = transcript.endItem(event)
	return { meta: t.meta, items: [...settled, ...transcript.blockItems(t.live.turn.blocks), end] }
}

export const transcript = { blockItems, recordItems, endItem, fromSnapshot, copyTurn, fold }
