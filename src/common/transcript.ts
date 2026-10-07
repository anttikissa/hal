// The transcript every client shows: one pure fold of a session snapshot
// and the live events after it (src/common/protocol.ts). A client
// following live events and one reconnecting show the same transcript.
// Provider input comes from host history; items omit provider-only fields.
// Tasks: ca, nvm, 6eq.

import { blocks, type AssistantBlock, type ImageBlock, type Sender, type ToolResultBlock, type Usage } from './blocks.ts'
import { forms, type Answers, type Form } from './forms.ts'
import { inbox, type InboxItem } from './inbox.ts'
import type { Event, LiveTurn, Snapshot, Stats, TurnStatus } from './protocol.ts'
import { rebaseDisplay } from './rebase-display.ts'
import { transcriptOrder } from './transcript-order.ts'
import { replay, type HistoryRecord, type PromptChange } from './replay.ts'
import type { SessionMeta } from './session.ts'
import type { SessionState } from './states.ts'

// An item as shown; Item adds its key.
export type Shown = { originSession?: string } & (
	// `from`: the session that sent it, `label` naming it; without it,
	// the human. `ts`: when it was sent (task hp).
	| ({ type: 'prompt'; text: string; queued?: true; waiting?: true; ts?: string } & Sender)
	// An image attached to the prompt before it (task 2a).
	| { type: 'image'; blob: string; mediaType: string; bytes?: number; ts?: string }
	// `ts`: when the block started; `model`, `effort`: what wrote it
	// (task hp). Records from before hp have none of them.
	| { type: 'text'; text: string; naming?: true; interrupted?: true; ts?: string; model?: string; effort?: string }
	| { type: 'thinking'; text: string; ts?: string; model?: string; effort?: string }
	| { type: 'tool'; id: string; name: string; input: Record<string, unknown>; partial?: string; ts?: string }
	| { type: 'tool-result'; id: string; output: string; isError?: boolean; ms?: number; interrupted?: 'canceled' | 'stopped'; ts?: string }
	| { type: 'turn-end'; status: TurnStatus; usage?: Usage; error?: string; ts?: string }
	// A durable question; with `answers` once answered (secrets only named).
	// `canceled`: dismissed (Escape, or a newer question replaced it).
	// `command`: a slash command asked; open in any session state.
	| { type: 'question'; id: string; form: Form; answers?: Answers; secrets?: string[]; canceled?: true; command?: true; ts?: string }
	// A slash command: origin identifies Hal; from identifies another session.
	| { type: 'command'; text: string; from?: string; label?: string; ts?: string }
	// What a command said.
	| { type: 'output'; text: string; error?: true; synthetic?: true; change?: PromptChange; ts?: string }
	// A compact (task bc), drawn as a one-row rule. A /clear (task vh)
	// shows as an output: 'HH:MM Context cleared.'.
	| { type: 'divider'; text: string; ts?: string }
)

// Stable key: record n, n.i for extra items; unnumbered events use ~position.
export type Item = Shown & { key: string }

export type Transcript = {
	dropped?: number[]
	rewrites?: Snapshot['rewrites']
	meta: SessionMeta
	// The session's state, as the host last said (src/common/states.ts).
	state: SessionState
	// Messages waiting for the turn (src/common/inbox.ts); always shown.
	inbox: InboxItem[]
	queueHold?: string
	// Everything to show, in order, including the running turn's output.
	items: Item[]
	// Where a last-prompt edit replaces items and everything after.
	prompt?: number
	// Running output starts here, drawn from this raw turn.
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
		else if (b.text || (b.type === 'text' && by.interrupted)) {
			let item: Item & { type: 'text' | 'thinking' } = { type: b.type, text: b.text, key }
			if (b.type === 'text' && b.naming) (item as Item & { type: 'text' }).naming = true
			if (b.type === 'text' && by.interrupted) (item as Item & { type: 'text' }).interrupted = true
			if (by.ts?.[i] !== undefined) item.ts = by.ts[i]
			if (by.model !== undefined) item.model = by.model
			if (by.effort !== undefined) item.effort = by.effort
			out.push(item)
		}
	}
	return out
}

type By = { interrupted?: true; model?: string; effort?: string; ts?: string[] }

// A live turn's blocks as items going at `at`.
function turnItems(turn: LiveTurn, at: number): Item[] {
	return transcript.blockItems(turn.blocks, turn.ns, at, turn)
}

// A prompt text as shown, saying who sent it if not the human.
function promptItem(text: string, s?: Sender, ts?: string, queued = false): Shown & { type: 'prompt' } {
	let item: Shown & { type: 'prompt' } = { type: 'prompt', text, ...inbox.sender(s ?? {}) }
	if (ts !== undefined) item.ts = ts
	if (queued) item.queued = true
	return item
}

// Waiting messages are normal prompt items keyed by their first inbox
// record's history line (task 9p); queued ones draw compact (task 16).
function waitingItem(item: InboxItem): Item {
	let key = item.n === undefined ? item.id : `${item.n}`
	return { ...transcript.promptItem(item.text, inbox.provenance(item), item.ts, !!item.queue), waiting: true, key }
}
function key(n: number | undefined, i: number, at: number): string {
	return n === undefined ? `~${at}` : i ? `${n}.${i}` : `${n}`
}

// The address of block `key` of session `session`, the same in every
// client (task 0z): /<session>#<key>, any kind letter kept (t19, 9p).
// Undefined for any other key (`~<n>`, a waiting message's id).
function href(session: string, key: string): string | undefined {
	return /^[umartsq]?\d+(\.\d+)?$/.test(key) ? `/${session}#${key}` : undefined
}

// `shown` as the items of record (or event) number `n`, going at `at`.
function keyed(shown: Shown[], n: number | undefined, at: number): Item[] {
	return shown.map((s, i) => ({ ...s, key: transcript.key(n, i, at + i) }) as Item)
}
function imageItem(b: ImageBlock, ts?: string): Shown {
	let item: Shown = { type: 'image', blob: b.blob, mediaType: b.mediaType }
	if (b.bytes !== undefined) item.bytes = b.bytes
	if (ts !== undefined) item.ts = ts
	return item
}
function resultItem(b: ToolResultBlock, ts?: string): Shown {
	let item: Shown = { type: 'tool-result', id: b.id, output: b.output }
	if (b.isError) item.isError = true
	if (b.ms !== undefined) item.ms = b.ms
	if (b.interrupted !== undefined) item.interrupted = b.interrupted
	if (ts !== undefined) item.ts = ts
	return item
}

// Display items for one history record, going at `at`.
function recordItems(r: HistoryRecord, at: number): Item[] {
	let items = r.type === 'assistant'
		? transcript.blockItems([r.block], r.n === undefined ? undefined : [r.n], at, { model: r.model, effort: r.effort, ts: [r.ts], interrupted: r.interrupted })
		: transcript.keyed(transcript.recordShown(r), r.n, at)
	return r.originSession === undefined ? items : items.map((item) => ({ ...item, originSession: r.originSession }))
}
function recordShown(r: HistoryRecord): Shown[] {
	if (r.type === 'rate_limit') return [{ type: 'output', text: r.text, ts: r.ts }]
	if (r.type === 'rebase' || r.type === 'file_changes' || r.type === 'round' || r.type === 'continue' || r.type === 'inbox' || r.type === 'answer' || r.type === 'notice' || r.type === 'change' || r.type === 'assistant') return []
	if (r.type === 'question') return [{ type: 'question', id: r.id, form: r.form, ...(r.from && { command: true as const }), ts: r.ts }]
	if ((r.type === 'output' && r.transitionDone) || ((r.type === 'command' || r.type === 'output') && r.origin === 'model')) return [] // model-run: its tool card shows it (9g)
	if (r.type === 'command' || r.type === 'output') return [transcript.aside(r)]
	if (r.type === 'reset') return [{ type: 'output', text: transcript.boundary(r), ts: r.ts }]
	if (r.type === 'compact') return [{ type: 'divider', text: transcript.boundary(r), ts: r.ts }]
	if (r.type === 'user') return r.blocks.map((b): Shown => (b.type === 'text' ? transcript.promptItem(b.text, b, r.ts, r.queued) : b.type === 'image' ? transcript.imageItem(b, r.ts) : transcript.resultItem(b, r.ts)))
	return [transcript.endItem(r)]
}
function endItem(end: { status: TurnStatus; usage?: Usage; error?: string; ts?: string }): Shown {
	let item: Shown = { type: 'turn-end', status: end.status }
	if (end.ts !== undefined) item.ts = end.ts
	if (end.usage && Object.keys(end.usage).length) item.usage = end.usage
	if (end.error !== undefined) item.error = end.error
	return item
}
function answered(items: Item[], answer: { question: string; answers: Answers; secrets?: string[]; canceled?: true }): Item[] {
	return items.map((item) => {
		if (item.type !== 'question' || item.id !== answer.question) return item
		let done: Item = { ...item, answers: answer.answers }
		if (answer.secrets) done.secrets = answer.secrets
		if (answer.canceled) done.canceled = true
		return done
	})
}
function boundary(r: { type: 'compact'; prompts: number } | { type: 'reset' }): string {
	return r.type === 'reset' ? 'Context cleared.' : `context compacted (${r.prompts} prompt${r.prompts === 1 ? '' : 's'} summarized)`
}

function aside(r: { type: 'command'; text: string; from?: string; label?: string; ts?: string } | { type: 'output'; text: string; error?: true; synthetic?: true; change?: PromptChange; ts?: string } | { type: 'divider'; text: string; ts?: string; clear?: true } | { type: 'question'; id: string; form: Form; ts?: string }): Shown {
	if (r.type === 'question') return { type: 'question', id: r.id, form: r.form, command: true, ...(r.ts !== undefined && { ts: r.ts }) }
	if (r.type === 'divider') return { type: r.clear ? 'output' : 'divider', text: r.text, ...(r.ts !== undefined && { ts: r.ts }) }
	if (r.type === 'command') return { type: 'command', text: r.text, ...(r.from !== undefined && { from: r.from }), ...(r.label !== undefined && { label: r.label }), ...(r.ts !== undefined && { ts: r.ts }) }
	return { type: 'output', text: r.text, ...(r.error && { error: true }), ...(r.synthetic && { synthetic: true }), ...(r.change && { change: r.change }), ...(r.ts !== undefined && { ts: r.ts }) }
}

// The question waiting for an answer from this transcript, if any: a
// command's while unanswered, a turn's while the turn waits on it.
function question(t: Transcript | undefined): (Item & { type: 'question' }) | undefined {
	let last = t?.items.findLast((item) => item.type === 'question')
	if (last?.type !== 'question' || last.answers || last.canceled) return undefined
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
	let history = rebaseDisplay.current(snapshot.history)
	let cleared = history.findLastIndex((r) => r.type === 'reset')
	if (cleared >= 0) history = history.slice(cleared)
	let early = cleared >= 0 ? [] : transcript.standIns(snapshot.earlier ?? [], snapshot.history)
	let queued = new Set([...early, ...snapshot.history].flatMap((r) => r.type === 'inbox' && r.queue ? [r.id] : []))
	let origins = new Map([...(snapshot.earlier ?? []), ...snapshot.history].flatMap((r) => r.type === 'inbox' ? [[r.id, r] as const] : []))
	for (let r of [...early, ...history]) {
		if (r.type === 'user' && r.inbox?.some((id) => queued.has(id))) r = { ...r, queued: true }
		if (r.type === 'user' && r.inbox?.length) {
			let i = 0, ids = r.inbox
			r = { ...r, blocks: r.blocks.map((b) => {
				if (b.type !== 'text') return b
				let origin = origins.get(ids[i++] ?? '')
				return origin && inbox.provenance(origin).steering ? { ...b, steering: true } : origin?.interject ? { ...b, interject: true } : b
			}) }
		}
		if (replay.isPrompt(r)) prompt = items.length
		if (r.type === 'answer') items = transcript.answered(items, r)
		else if (r.type === 'rebase') items.push(...transcript.keyed([{ type: 'divider', text: rebaseDisplay.text(r, snapshot.history), ts: r.ts }], r.n, items.length))
		else items.push(...transcript.recordItems(r, items.length))
	}
	let promptKey = items[prompt ?? -1]?.key
	items = transcriptOrder.order(items)
	items = rebaseDisplay.insert(items, snapshot.rewrites)
	let t: Transcript = { meta: { ...snapshot.meta }, state: snapshot.state, inbox: snapshot.inbox ?? [], items }
	if (prompt !== undefined) t.prompt = items.findIndex((item) => item.key === promptKey)
	if (snapshot.rewrites) t.rewrites = snapshot.rewrites
	if (snapshot.dropped) t.dropped = [...snapshot.dropped]
	if (snapshot.stats) t.stats = snapshot.stats
	if (snapshot.queueHold) t.queueHold = snapshot.queueHold
	if (early.length) t.earlier = transcript.fromSnapshot({ ...snapshot, history: early, earlier: [], turn: undefined }).items.length
	if (snapshot.turn) {
		let turn = transcript.copyTurn(snapshot.turn)
		t.live = { start: items.length, turn }
		t.items = transcriptOrder.order([...items, ...transcript.turnItems(turn, items.length)])
		t.live.start = Math.min(items.length, ...turn.ns?.map((n) => t.items.findIndex((item) => item.key === String(n))).filter((at) => at >= 0) ?? [])
	}
	if (snapshot.toolOutput) t.items = t.items.map((item) => item.type === 'tool' && item.id === snapshot.toolOutput!.id ? { ...item, partial: snapshot.toolOutput!.output } : item)
	return t
}

// `t` with the items of `page`, the history just before `loaded` (the
// records `t` was folded from so far), in front, in place of any stand-
// ins for it: as if the snapshot had held page and loaded together.
// With `keep`, the stand-ins are from further back: they stay on top.
function prepend(t: Transcript, loaded: HistoryRecord[], page: HistoryRecord[], keep = false): Transcript {
	let base = { meta: t.meta, state: t.state, rewrites: t.rewrites }
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
		if (item.type === 'question' && item.answers) prefix = transcript.answered(prefix, { question: item.id, answers: item.answers, ...(item.secrets ? { secrets: item.secrets } : {}), ...(item.canceled ? { canceled: true as const } : {}) })
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
	if ((event.type === 'snapshot' || event.type === 'history-rewritten')) return t && t.meta.id !== event.sessionId ? t : transcript.fromSnapshot(event.snapshot)
	if (!t || !('sessionId' in event) || event.type === 'rejected' || event.type === 'draft' || event.sessionId !== t.meta.id) return t
	if (event.type === 'state') return { ...t, state: event.state }
	if (event.type === 'queue-hold') { let { queueHold: _hold, ...rest } = t; return event.message ? { ...rest, queueHold: event.message } : rest }
	if (event.type === 'inbox') return { ...t, inbox: event.inbox }
	if (event.type === 'answer') return { ...t, items: transcript.answered(t.items, event) }
	if (event.type === 'meta') return { ...t, meta: { ...event.meta }, ...(event.stats && { stats: event.stats }) }
	if (event.type === 'turn-stats') return { ...t, stats: event.stats }
	if (event.type === 'turn-end' && event.stats) t = { ...t, stats: event.stats }
	if (event.type === 'assistant-interrupted') {
		let items = t.live ? transcript.settle(t.items, t.live) : t.items
		items = transcriptOrder.order([...items.filter((item) => item.key !== String(event.record.n)), ...transcript.recordItems(event.record, items.length)])
		return { ...t, items, ...(t.live && { live: { start: items.length, turn: transcript.fresh(t.live.turn) } }) }
	}
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
	if (event.type === 'completions' || event.type === 'history' || ((event.type === 'command' || event.type === 'output') && event.origin === 'model')) return t
	// A command's question is an aside too: it never ends the turn.
	if (event.type === 'divider' && event.clear && !t.live) {
		let { prompt: _p, earlier: _e, ...rest } = t
		return { ...rest, items: transcript.keyed([transcript.aside(event)], event.n, 0) }
	}
	if (event.type === 'command' || event.type === 'output' || event.type === 'divider' || (event.type === 'question' && event.command)) {
		return { ...t, items: [...t.items, ...transcript.keyed([transcript.aside(event)], event.n, t.items.length)] }
	}
	if (event.type === 'turn-start') {
		if (event.prompt === undefined) return { ...t, live: { start: t.items.length, turn: transcript.fresh(event) } }
		let items: Item[] = [...t.items, ...transcript.keyed([transcript.promptItem(event.prompt, event.sender, event.ts, event.queued), ...(event.images ?? []).map((b) => transcript.imageItem(b, event.ts))], event.n, t.items.length)]
		return { ...t, items, prompt: t.items.length, live: { start: items.length, turn: transcript.fresh(event) } }
	}
	let question: Shown | undefined = event.type === 'question' ? { type: 'question', id: event.id, form: event.form, ...(event.ts !== undefined && { ts: event.ts }) } : undefined
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
		let items = transcriptOrder.replace(live === t.live ? t.items : settled, live.start, transcript.turnItems(live.turn, live.start), transcript.turnItems(turn, live.start))
		return { ...t, items, live: { start: live.start, turn } }
	}
	if (event.type === 'tool-results') {
		// The round's blocks are in history now; the next round starts empty.
		let done = transcript.settle(t.items, t.live).map((item): Item => item.type === 'tool' && event.results.some((r) => r.id === item.id) ? { ...item, partial: undefined } : item)
		let items = [...done, ...transcript.keyed(event.results.map((b) => transcript.resultItem(b, event.ts)), event.n, done.length)]
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
	return transcriptOrder.replace(items, live.start, transcript.turnItems(live.turn, live.start), transcript.turnItems(live.turn, live.start))
}

// After `items`, a prompt event's texts; an edit (`replaces`) takes
// the place of the last prompt and everything after it.
function prompted(t: Transcript, items: Item[], event: Event & { type: 'prompt' }): Transcript {
	let keep = event.replaces && t.prompt !== undefined ? items.slice(0, t.prompt) : items
	let { live: _live, ...rest } = t
	let shown: Shown[] = [...event.texts.map((text, i) => transcript.promptItem(text, event.senders?.[i], event.ts, event.queued)), ...(event.images ?? []).map((b) => transcript.imageItem(b, event.ts))]
	return { ...rest, items: [...keep, ...transcript.keyed(shown, event.n, keep.length)], prompt: keep.length }
}

export const transcript = { blockItems, turnItems, fresh, promptItem, waitingItem, key, href, keyed, imageItem, resultItem, recordItems, recordShown, endItem, settle, boundary, aside, answered, question, standIns, fromSnapshot, prepend, copyTurn, fold, prompted }
