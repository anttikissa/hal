// The transcript every client shows: one pure fold of a session snapshot
// and the live events after it (src/common/protocol.ts). A client that
// followed the events and one that connected later end up with equal
// transcripts. This is display state only; provider input is rebuilt
// from history on the host, never from here, so items drop what only a
// provider needs (thinking signatures, their provider).

import { blocks, type AssistantBlock, type ImageBlock, type Sender, type ToolResultBlock, type Usage } from './blocks.ts'
import { forms, type Answers, type Form } from './forms.ts'
import { inbox, type InboxItem } from './inbox.ts'
import type { Event, LiveTurn, Snapshot, Stats, TurnStatus } from './protocol.ts'
import { replay, type HistoryRecord } from './replay.ts'
import type { SessionMeta } from './session.ts'
import type { SessionState } from './states.ts'

// An item as shown; Item adds its key.
export type Shown = { originSession?: string } & (
	// `from`: the session that sent it, `label` naming it; without it,
	// the human. `ts`: when it was sent (task hp).
	| { type: 'prompt'; text: string; from?: string; label?: string; queued?: true; steering?: true; advisory?: true; summary?: string; ts?: string }
	// An image attached to the prompt before it (task 2a).
	| { type: 'image'; blob: string; mediaType: string; bytes?: number }
	// `ts`: when the block started; `model`, `effort`: what wrote it
	// (task hp). Records from before hp have none of them.
	| { type: 'text'; text: string; naming?: true; ts?: string; model?: string; effort?: string }
	| { type: 'thinking'; text: string; ts?: string; model?: string; effort?: string }
	| { type: 'tool'; id: string; name: string; input: Record<string, unknown>; partial?: string; ts?: string }
	| { type: 'tool-result'; id: string; output: string; isError?: boolean }
	| { type: 'turn-end'; status: TurnStatus; usage?: Usage; error?: string }
	// A durable question; with `answers` once answered (secrets only named).
	// `cancelled`: dismissed (Escape, or a newer question replaced it).
	// `command`: a slash command asked; open in any session state.
	| { type: 'question'; id: string; form: Form; answers?: Answers; secrets?: string[]; cancelled?: true; command?: true }
	// A slash command: origin identifies Hal; from identifies another session.
	| { type: 'command'; text: string; origin?: 'model'; from?: string; ts?: string }
	// What a command said.
	| { type: 'output'; text: string; error?: true; ts?: string }
	// A compact (task bc), drawn as a one-row rule. A /clear (task vh)
	// shows as an output: 'HH:MM Context cleared.'.
	| { type: 'divider'; text: string }
)

// `key`: the item's id (task w5), the same live, after a reconnect or
// reload and in a page of earlier history: its record's number `n`, with
// `.<i>` for the i-th item after the first of a record that yields
// several (a prompt's images, a round's tool results). Only a record or
// event without a number (built by hand) falls back to `~<position>`.
export type Item = Shown & { key: string }

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
	// How many items at the start stand in for history not loaded yet
	// (standIns); loading it (prepend) replaces them.
	earlier?: number
	// For the status row (task 1g): the latest the host sent.
	stats?: Stats
}

// Display items for assistant blocks. Empty thinking (a bare signature,
// redacted reasoning) shows nothing.
// `ns`: the blocks' record numbers; `at`: where the items will go;
// `by`: the model and effort that wrote them and when each started.
function blockItems(list: AssistantBlock[], ns: number[] | undefined, at: number, by: By = {}): Item[] {
	let out: Item[] = []
	for (let [i, b] of list.entries()) {
		let key = transcript.key(ns?.[i], 0, at + out.length)
		if (b.type === 'tool_call') out.push({ type: 'tool', id: b.id, name: b.name, input: b.input, key, ...(by.ts?.[i] !== undefined && { ts: by.ts[i] }) })
		else if (b.text) {
			let item: Item & { type: 'text' | 'thinking' } = { type: b.type, text: b.text, key }
			if (b.type === 'text' && b.naming) (item as Item & { type: 'text' }).naming = true
			if (by.ts?.[i] !== undefined) item.ts = by.ts[i]
			if (by.model !== undefined) item.model = by.model
			if (by.effort !== undefined) item.effort = by.effort
			out.push(item)
		}
	}
	return out
}

type By = { model?: string; effort?: string; ts?: string[] }

// A live turn's blocks as items going at `at`.
function turnItems(turn: LiveTurn, at: number): Item[] {
	return transcript.blockItems(turn.blocks, turn.ns, at, turn)
}

// A prompt text as shown, saying who sent it if not the human.
function promptItem(text: string, s?: Sender, ts?: string, queued = false): Shown {
	let item: Shown = { type: 'prompt', text, ...inbox.sender(s ?? {}) }
	if (ts !== undefined) item.ts = ts
	if (queued) item.queued = true
	return item
}

// Waiting messages are normal prompt items. A queued one is keyed by
// its run position, q1, q2… (task 16); its clients draw a compact row.
function waitingItem(item: InboxItem, list: InboxItem[] = [item]): Item {
	let key = item.queue ? `q${list.filter((m) => m.queue).indexOf(item) + 1}` : item.id
	return { ...transcript.promptItem(item.text, inbox.provenance(item), undefined, !!item.queue), key }
}

function key(n: number | undefined, i: number, at: number): string {
	return n === undefined ? `~${at}` : i ? `${n}.${i}` : `${n}`
}

// The address of block `key` of session `session`, the same in every
// client (task 0z): /<session>#<key>; q1 for a queued message (task
// 16). Undefined for any other key, as a hand-built item's `~<n>`.
function href(session: string, key: string): string | undefined {
	return /^(\d+(\.\d+)?|q\d+)$/.test(key) ? `/${session}#${key}` : undefined
}

// `shown` as the items of record (or event) number `n`, going at `at`.
function keyed(shown: Shown[], n: number | undefined, at: number): Item[] {
	return shown.map((s, i) => ({ ...s, key: transcript.key(n, i, at + i) }) as Item)
}

function imageItem(b: ImageBlock): Shown {
	let item: Shown = { type: 'image', blob: b.blob, mediaType: b.mediaType }
	if (b.bytes !== undefined) item.bytes = b.bytes
	return item
}

function resultItem(b: ToolResultBlock): Shown {
	let item: Shown = { type: 'tool-result', id: b.id, output: b.output }
	if (b.isError) item.isError = true
	return item
}

// Display items for one history record, going at `at`.
function recordItems(r: HistoryRecord, at: number): Item[] {
	let items = r.type === 'assistant'
		? transcript.blockItems([r.block], r.n === undefined ? undefined : [r.n], at, { model: r.model, effort: r.effort, ts: [r.ts] })
		: transcript.keyed(transcript.recordShown(r), r.n, at)
	return r.originSession === undefined ? items : items.map((item) => ({ ...item, originSession: r.originSession }))
}

function recordShown(r: HistoryRecord): Shown[] {
	if (r.type === 'file_changes' || r.type === 'round' || r.type === 'continue' || r.type === 'inbox' || r.type === 'answer' || r.type === 'change' || r.type === 'assistant') return []
	if (r.type === 'question') return [r.from ? { type: 'question', id: r.id, form: r.form, command: true } : { type: 'question', id: r.id, form: r.form }]
	if (r.type === 'command' || r.type === 'output') return [transcript.aside(r)]
	if (r.type === 'reset') return [{ type: 'output', text: transcript.boundary(r), ts: r.ts }]
	if (r.type === 'compact') return [{ type: 'divider', text: transcript.boundary(r) }]
	if (r.type === 'user') return r.blocks.map((b): Shown => (b.type === 'text' ? transcript.promptItem(b.text, b, r.ts, r.queued) : b.type === 'image' ? transcript.imageItem(b) : transcript.resultItem(b)))
	return [transcript.endItem(r)]
}

// A turn end as shown, the same from a record or a live turn-end event.
function endItem(end: { status: TurnStatus; usage?: Usage; error?: string }): Shown {
	let item: Shown = { type: 'turn-end', status: end.status }
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

// What a context boundary's divider says.
function boundary(r: { type: 'compact'; prompts: number } | { type: 'reset' }): string {
	return r.type === 'reset' ? 'Context cleared.' : `context compacted (${r.prompts} prompt${r.prompts === 1 ? '' : 's'} summarised)`
}

// A command, its output or a divider as shown, from a record or an event.
function aside(r: { type: 'command'; text: string; origin?: 'model'; from?: string; ts?: string } | { type: 'output'; text: string; error?: true; ts?: string } | { type: 'divider'; text: string; ts?: string; clear?: true } | { type: 'question'; id: string; form: Form }): Shown {
	if (r.type === 'question') return { type: 'question', id: r.id, form: r.form, command: true }
	if (r.type === 'divider') return r.clear ? { type: 'output', text: r.text, ...(r.ts !== undefined && { ts: r.ts }) } : { type: 'divider', text: r.text }
	if (r.type === 'command') return { type: 'command', text: r.text, ...(r.origin && { origin: r.origin }), ...(r.from !== undefined && { from: r.from }), ...(r.ts !== undefined && { ts: r.ts }) }
	return { type: 'output', text: r.text, ...(r.error && { error: true }), ...(r.ts !== undefined && { ts: r.ts }) }
}

// The question waiting for an answer from this transcript, if any: a
// command's while unanswered, a turn's while the turn waits on it.
function question(t: Transcript | undefined): (Item & { type: 'question' }) | undefined {
	let last = t?.items.findLast((item) => item.type === 'question')
	if (last?.type !== 'question' || last.answers || last.cancelled) return undefined
	return last.command || (t?.state.type === 'blocked' && t.state.reason === 'question') ? last : undefined
}

// Earlier records (a snapshot's `earlier`) to show before the tail
// until the history before it is loaded: the open question, and the
// prompt of a turn the tail starts in the middle of.
function standIns(earlier: HistoryRecord[], tail: HistoryRecord[]): HistoryRecord[] {
	let open = forms.open([...earlier, ...tail])
	let cut = !tail.some((r) => replay.isPrompt(r))
	let prompt = cut ? earlier.findLast((r) => replay.isPrompt(r)) : undefined
	return earlier.filter((r) => r === open || r === prompt)
}

function fromSnapshot(snapshot: Snapshot): Transcript {
	let items: Item[] = []
	let prompt: number | undefined
	// A /clear (task vh) hides everything before it.
	let history = replay.current(snapshot.history)
	let cleared = history.findLastIndex((r) => r.type === 'reset')
	if (cleared >= 0) history = history.slice(cleared)
	let early = cleared >= 0 ? [] : transcript.standIns(snapshot.earlier ?? [], snapshot.history)
	let queued = new Set([...early, ...snapshot.history].flatMap((r) => r.type === 'inbox' && r.queue ? [r.id] : []))
	let origins = new Map([...(snapshot.earlier ?? []), ...snapshot.history].flatMap((r) => r.type === 'inbox' ? [[r.id, r] as const] : []))
	for (let r of [...early, ...history]) {
		// Older delivered records kept only their inbox IDs, not provenance.
		if (r.type === 'user' && r.inbox?.some((id) => queued.has(id))) r = { ...r, queued: true }
		if (r.type === 'user' && r.inbox?.length) {
			let i = 0, ids = r.inbox
			r = { ...r, blocks: r.blocks.map((b) => {
				if (b.type !== 'text') return b
				let origin = origins.get(ids[i++] ?? '')
				return origin && inbox.provenance(origin).steering ? { ...b, steering: true } : b
			}) }
		}
		if (replay.isPrompt(r)) prompt = items.length
		if (r.type === 'answer') items = transcript.answered(items, r)
		else items.push(...transcript.recordItems(r, items.length))
	}
	let t: Transcript = { meta: { ...snapshot.meta }, state: snapshot.state, inbox: snapshot.inbox ?? [], items }
	if (prompt !== undefined) t.prompt = prompt
	if (snapshot.stats) t.stats = snapshot.stats
	if (early.length) t.earlier = transcript.fromSnapshot({ ...snapshot, history: early, earlier: [], turn: undefined }).items.length
	if (snapshot.turn) {
		let turn = transcript.copyTurn(snapshot.turn)
		t.live = { start: items.length, turn }
		t.items = [...items, ...transcript.turnItems(turn, items.length)]
	}
	if (snapshot.toolOutput) t.items = t.items.map((item) => item.type === 'tool' && item.id === snapshot.toolOutput!.id ? { ...item, partial: snapshot.toolOutput!.output } : item)
	return t
}

// `t` with the items of `page`, the history just before `loaded` (the
// records `t` was folded from so far), in front, in place of any stand-
// ins for it: as if the snapshot had held page and loaded together.
// With `keep`, the stand-ins are from further back: they stay on top.
function prepend(t: Transcript, loaded: HistoryRecord[], page: HistoryRecord[], keep = false): Transcript {
	let base = { meta: t.meta, state: t.state }
	let full = transcript.fromSnapshot({ ...base, history: [...page, ...loaded] })
	let prefix: Item[] = full.items.slice(0, Math.max(0, full.items.length - transcript.fromSnapshot({ ...base, history: loaded }).items.length))
	if (keep && t.earlier) {
		let at = t.earlier
		let out: Transcript = { ...t, items: [...t.items.slice(0, at), ...prefix, ...t.items.slice(at)] }
		if (t.prompt !== undefined && t.prompt >= at) out.prompt = t.prompt + prefix.length
		if (t.live) out.live = { start: t.live.start + prefix.length, turn: t.live.turn }
		return out
	}
	let drop = t.earlier ?? 0
	// A stand-in question answered meanwhile is answered in its place.
	for (let item of t.items.slice(0, drop)) {
		if (item.type === 'question' && item.answers) prefix = transcript.answered(prefix, { question: item.id, answers: item.answers, ...(item.secrets ? { secrets: item.secrets } : {}), ...(item.cancelled ? { cancelled: true as const } : {}) })
	}
	let shift = prefix.length - drop
	let { earlier: _earlier, ...out }: Transcript = { ...t, items: [...prefix, ...t.items.slice(drop)] }
	if (t.prompt !== undefined && t.prompt >= drop) out.prompt = t.prompt + shift
	else if (full.prompt !== undefined && full.prompt < prefix.length) out.prompt = full.prompt
	else delete out.prompt
	if (t.live) out.live = { start: t.live.start + shift, turn: t.live.turn }
	return out
}

// A copy that blocks.apply may mutate without touching the original:
// apply only ever changes the last block and the usage.
function copyTurn(turn: LiveTurn): LiveTurn {
	let list = turn.blocks.slice()
	let last = list.at(-1)
	if (last) list[list.length - 1] = { ...last }
	let copy: LiveTurn = { ...transcript.fresh(turn), blocks: list, usage: { ...turn.usage } }
	if (turn.ns) copy.ns = turn.ns.slice()
	if (turn.ts) copy.ts = turn.ts.slice()
	return copy
}

// An empty live turn by the provider, model and effort of `like`.
function fresh(like: { provider: string; model?: string; effort?: string }): LiveTurn {
	let turn: LiveTurn = { provider: like.provider, blocks: [], usage: {} }
	if (like.model !== undefined) turn.model = like.model
	if (like.effort !== undefined) turn.effort = like.effort
	return turn
}

// The transcript after `event`; the same object if the event does not
// concern it. Events before the first snapshot are ignored.
function fold(t: Transcript | undefined, event: Event): Transcript | undefined {
	if (event.type === 'snapshot') return t && t.meta.id !== event.sessionId ? t : transcript.fromSnapshot(event.snapshot)
	if (!t || !('sessionId' in event) || event.type === 'rejected' || event.type === 'draft' || event.sessionId !== t.meta.id) return t
	if (event.type === 'state') return { ...t, state: event.state }
	if (event.type === 'inbox') return { ...t, inbox: event.inbox }
	if (event.type === 'answer') return { ...t, items: transcript.answered(t.items, event) }
	if (event.type === 'meta') return { ...t, meta: { ...event.meta }, ...(event.stats && { stats: event.stats }) }
	if (event.type === 'turn-stats') return { ...t, stats: event.stats }
	if (event.type === 'turn-end' && event.stats) t = { ...t, stats: event.stats }
	if (event.type === 'tool-output') {
		let changed = false
		let items = t.items.map((item): Item => {
			if (item.type !== 'tool' || item.id !== event.id) return item
			let before = item.partial ?? ''
			let added = event.chunk.slice(Math.max(0, before.length - event.at))
			if (!added || event.at > before.length) return item
			changed = true
			return { ...item, partial: before + added }
		})
		return changed ? { ...t, items } : t
	}
	if (event.type === 'completions' || event.type === 'history') return t
	// A command's question is an aside too: it never ends the turn.
	if (event.type === 'divider' && event.clear && !t.live) {
		let { prompt: _p, earlier: _e, ...rest } = t
		return { ...rest, items: transcript.keyed([transcript.aside(event)], event.n, 0) }
	}
	if (event.type === 'command' || event.type === 'output' || event.type === 'divider' || (event.type === 'question' && event.command)) {
		// Where history has it: after the running round's blocks already
		// written, before the one still streaming (`streaming`), which
		// stays live; as a snapshot taken now or later shows it.
		if (!t.live) return { ...t, items: [...t.items, ...transcript.keyed([transcript.aside(event)], event.n, t.items.length)] }
		let { blocks: list, ns, ts } = t.live.turn
		let keep = event.streaming ? Math.max(0, list.length - 1) : list.length
		let done = transcript.settle(t.items, { start: t.live.start, turn: { ...t.live.turn, blocks: list.slice(0, keep) } })
		let items = [...done, ...transcript.keyed([transcript.aside(event)], event.n, done.length)]
		let turn = transcript.copyTurn({ ...t.live.turn, blocks: list.slice(keep), ...(ns ? { ns: ns.slice(keep) } : {}), ...(ts ? { ts: ts.slice(keep) } : {}) })
		return { ...t, items: [...items, ...transcript.turnItems(turn, items.length)], live: { start: items.length, turn } }
	}
	if (event.type === 'turn-start') {
		if (event.prompt === undefined) return { ...t, live: { start: t.items.length, turn: transcript.fresh(event) } }
		let items: Item[] = [...t.items, ...transcript.keyed([transcript.promptItem(event.prompt, event.sender, event.ts, event.queued), ...(event.images ?? []).map((b) => transcript.imageItem(b))], event.n, t.items.length)]
		return { ...t, items, prompt: t.items.length, live: { start: items.length, turn: transcript.fresh(event) } }
	}
	let question: Shown | undefined = event.type === 'question' ? { type: 'question', id: event.id, form: event.form } : undefined
	let ended = (items: Item[], end: Shown): Item[] => [...items, ...transcript.keyed([end], (event as { n?: number }).n, items.length)]
	// A turn left unfinished by another host ends without running here.
	if (!t.live) {
		if (event.type === 'turn-end') return { ...t, items: ended(t.items, transcript.endItem(event)) }
		if (event.type === 'prompt') return transcript.prompted(t, t.items, event)
		return question ? { ...t, items: ended(t.items, question) } : t
	}
	let settled = t.items.slice(0, t.live.start)
	if (event.type === 'prompt') {
		// The round's blocks are in history before the prompt.
		let next = transcript.prompted(t, transcript.settle(t.items, t.live), event)
		return { ...next, live: { start: next.items.length, turn: transcript.fresh(t.live.turn) } }
	}
	if (event.type === 'stream') {
		let live = t.live
		if (event.model !== undefined && (event.model !== live.turn.model || event.effort !== live.turn.effort)) {
			settled = transcript.settle(t.items, live)
			live = { start: settled.length, turn: transcript.fresh({ provider: event.model.split('/')[0]!, model: event.model, effort: event.effort }) }
		}
		let turn = transcript.copyTurn(live.turn)
		blocks.apply(turn, event.event)
		while (turn.ns && event.n !== undefined && turn.ns.length < turn.blocks.length) turn.ns.push(event.n)
		if (!turn.ns && event.n !== undefined && turn.blocks.length) turn.ns = turn.blocks.map(() => event.n!)
		// A block's start time comes with its first event.
		while (event.ts !== undefined && (turn.ts ??= []).length < turn.blocks.length) turn.ts.push(event.ts)
		return { ...t, items: [...settled, ...transcript.turnItems(turn, settled.length)], live: { start: live.start, turn } }
	}
	if (event.type === 'tool-results') {
		// The round's blocks are in history now; the next round starts empty.
		let done = transcript.settle(t.items, t.live).map((item): Item => item.type === 'tool' && event.results.some((r) => r.id === item.id) ? { ...item, partial: undefined } : item)
		let items = [...done, ...transcript.keyed(event.results.map((b) => transcript.resultItem(b)), event.n, done.length)]
		return { ...t, items, live: { start: items.length, turn: transcript.fresh(t.live.turn) } }
	}
	// Attachments, notices and other session events are not turn ends.
	if (event.type !== 'question' && event.type !== 'turn-end') return t
	// Asking stops the running turn: its output is in history.
	let end = question ?? transcript.endItem(event as Event & { type: 'turn-end' })
	let { live: _live, ...rest } = t
	return { ...rest, items: ended(transcript.settle(t.items, t.live), end) }
}

// The items with the live turn's blocks settled as history has them.
function settle(items: Item[], live: NonNullable<Transcript['live']>): Item[] {
	return [...items.slice(0, live.start), ...transcript.turnItems(live.turn, live.start)]
}

// After `items`, a prompt event's texts; an edit (`replaces`) takes
// the place of the last prompt and everything after it.
function prompted(t: Transcript, items: Item[], event: Event & { type: 'prompt' }): Transcript {
	let keep = event.replaces && t.prompt !== undefined ? items.slice(0, t.prompt) : items
	let { live: _live, ...rest } = t
	let shown: Shown[] = [...event.texts.map((text, i) => transcript.promptItem(text, event.senders?.[i], event.ts, event.queued)), ...(event.images ?? []).map((b) => transcript.imageItem(b))]
	return { ...rest, items: [...keep, ...transcript.keyed(shown, event.n, keep.length)], prompt: keep.length }
}

export const transcript = { blockItems, turnItems, fresh, promptItem, waitingItem, key, href, keyed, imageItem, resultItem, recordItems, recordShown, endItem, settle, boundary, aside, answered, question, standIns, fromSnapshot, prepend, copyTurn, fold, prompted }
