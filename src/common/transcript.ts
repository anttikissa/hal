// The transcript every client shows: one pure fold of a session snapshot
// and the live events after it (src/common/protocol.ts; folding them is
// transcript-live.ts). A client following live events and one
// reconnecting show the same transcript. Provider input comes from host
// history; items omit provider-only fields.
// Tasks: ca, nvm, 6eq, rqq.

import {
	blocks,
	type AssistantBlock,
	type CommitBlock,
	type ImageBlock,
	type Sender,
	type ToolResultBlock,
	type ToolDisplay,
	type Usage,
} from './blocks.ts'
import { commandCards } from './command-cards.ts'
import { forms, type Answers, type Form } from './forms.ts'
import { inbox, type InboxItem } from './inbox.ts'
import type { TurnStatus } from './protocol.ts'
import type { LiveTurn, Snapshot, Stats } from './snapshot.ts'
import { rebaseDisplay } from './rebase-display.ts'
import { transcriptLive } from './transcript-live.ts'
import { transcriptOrder } from './transcript-order.ts'
import { replay, type HistoryRecord, type PromptChange } from './replay.ts'
import type { SessionMeta } from './session.ts'
import type { SessionState } from './states.ts'

// An item as shown; Item adds its key.
export type Shown = { originSession?: string } &
	// `from`: the session that sent it, `label` naming it; without it,
	// the human. `ts`: when it was sent (task hp). `edited`: the human
	// amended it (task 6ch).
	(
		| ({ type: 'prompt'; text: string; waiting?: true; edited?: true; ts?: string } & Sender)
		// An image attached to the prompt before it (task 2a).
		| { type: 'image'; blob: string; mediaType: string; bytes?: number; ts?: string }
		// `ts`: when the block started; `model`, `effort`: what wrote it
		// (task hp). Records from before hp have none of them.
		| {
				type: 'text'
				text: string
				naming?: true
				interrupted?: true
				synthetic?: true
				ts?: string
				model?: string
				effort?: string
		  }
		| { type: 'thinking'; text: string; ts?: string; model?: string; effort?: string }
		| (ToolDisplay & {
				type: 'tool'
				id: string
				name: string
				input: Record<string, unknown>
				cmd?: string
				partial?: string
				partialFrom?: number
				ts?: string
		  })
		| (ToolDisplay & {
				type: 'tool-result'
				id: string
				output: string
				isError?: boolean
				diff?: string
				ms?: number
				interrupted?: 'canceled' | 'stopped'
				ts?: string
		  })
		| { type: 'turn-end'; status: TurnStatus; usage?: Usage; error?: string; ts?: string }
		// A durable question; with `answers` once answered (secrets only named).
		// `canceled`: dismissed (Escape, or a newer question replaced it).
		// `command`: a slash command asked; open in any session state.
		| {
				type: 'question'
				id: string
				form: Form
				answers?: Answers
				secrets?: string[]
				canceled?: true
				command?: true
				ts?: string
		  }
		// A slash command: origin identifies Hal; from identifies another session.
		// `output`: what the human's command said, shown in its card (joined).
		| { type: 'command'; text: string; from?: string; label?: string; output?: string; error?: true; ts?: string }
		// What a command said.
		// `commit`: a commit a Bash call made (task 179), its own card.
		| {
				type: 'output'
				text: string
				error?: true
				change?: PromptChange
				commit?: CommitBlock
				notice?: true
				ts?: string
		  }
		// A compact (task bc), drawn as a one-row rule. A /clear (task vh)
		// shows as an output: 'HH:MM Context cleared. `/clear undo` to go back.'.
		| { type: 'divider'; text: string; ts?: string }
	)

// Stable key: record n, n.i for extra items; unnumbered events use ~position.
export type Item = Shown & { key: string }
// Streamed Bash output: `from` characters before `output` were dropped.
export type Streamed = { output: string; from: number }

export type Transcript = {
	dropped?: number[]
	rewrites?: Snapshot['rewrites']
	meta: SessionMeta
	// The session's state, as the host last said (src/common/states.ts).
	state: SessionState
	// Messages waiting for the turn (src/common/inbox.ts); always shown.
	inbox: InboxItem[]
	queueHold?: string
	// Running background jobs' output by call id, apart from items (task 6nn).
	jobOutput?: Record<string, Streamed>
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
		// A presented call keeps its command text for raw inspection (task sn7).
		if (b.type === 'tool_call')
			out.push({
				type: 'tool',
				id: b.id,
				name: b.name,
				input: b.input,
				...(b.presentation !== undefined && { presentation: b.presentation }),
				...(b.presentationError !== undefined && { presentationError: b.presentationError }),
				...((b.presentation || b.presentationError) && b.cmd !== undefined && { cmd: b.cmd }),
				key,
				...(by.ts?.[i] !== undefined && { ts: by.ts[i] }),
			})
		else if (b.type === 'hosted_tool') {
			let ts = by.ts?.[i] !== undefined ? { ts: by.ts[i] } : {}
			out.push(
				{ type: 'tool', id: b.id, name: b.name, input: b.input, key, ...ts },
				{
					type: 'tool-result',
					id: b.id,
					output: b.output,
					...(b.isError && { isError: true }),
					key: transcript.key(ns?.[i], 1, at + out.length + 1),
					...ts,
				},
			)
		} else if (b.text || (b.type === 'text' && by.interrupted)) {
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

// A prompt text as shown, saying who sent it if not the human.
function promptItem(text: string, s?: Sender, ts?: string, edited?: boolean): Shown & { type: 'prompt' } {
	let item: Shown & { type: 'prompt' } = { type: 'prompt', text, ...inbox.sender(s ?? {}) }
	if (ts !== undefined) item.ts = ts
	if (edited && item.from === undefined && item.origin !== 'model') item.edited = true
	return item
}

// Waiting messages are normal prompt items keyed by their first inbox
// record's history line (task 9p); queued ones draw compact (task 16).
function waitingItem(item: InboxItem): Item {
	let key = item.n === undefined ? item.id : `${item.n}`
	return { ...transcript.promptItem(item.text, inbox.provenance(item), item.ts), waiting: true, key }
}
function key(n: number | undefined, i: number, at: number): string {
	return n === undefined ? `~${at}` : i ? `${n}.${i}` : `${n}`
}

function addressable(key: string): boolean {
	return /^\d+(\.\d+)?$/.test(key)
}

// The address of block `key` of session `session`, the same in every
// client (task 0z): /<session>#<key>, any kind letter kept (t19, 9p).
// Undefined for any other key (`~<n>`, a waiting message's id).
function href(session: string, key: string): string | undefined {
	return transcript.addressable(key.replace(/^[umartsq]/, '')) ? `/${session}#${key}` : undefined
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
// A result, its images, then commits older histories stored with it
// (task 179): one record, so they share its number, keyed n.1, n.2.
function resultItems(b: ToolResultBlock, ts?: string): Shown[] {
	return [
		transcript.resultItem(b, ts),
		...blocks.resultImages(b).map((image) => transcript.imageItem(image, ts)),
		...(b.commits ?? []).map((c) => transcript.commitItem(c, ts)),
	]
}
// '<short> <subject>', a row per file ('+3 -1 src/a.ts'), then the
// hook's lines.
function commitItem(c: CommitBlock, ts?: string): Shown {
	let count = (n: number, sign: string) => (n < 0 ? 'bin' : `${sign}${n}`)
	let text = [
		`${c.short} ${c.subject}`,
		...c.files.map((f) => `${count(f.added, '+')} ${count(f.removed, '-')} ${f.path}`),
		...(c.lines ?? []),
	].join('\n')
	return { type: 'output', text, commit: c, ...(ts !== undefined && { ts }) }
}
function resultItem(b: ToolResultBlock, ts?: string): Shown {
	let item: Shown = { type: 'tool-result', id: b.id, output: b.output }
	if (b.isError) item.isError = true
	if (b.diff !== undefined) item.diff = b.diff
	if (b.presentation !== undefined) item.presentation = b.presentation
	if (b.presentationError !== undefined) item.presentationError = b.presentationError
	if (b.ms !== undefined) item.ms = b.ms
	if (b.interrupted !== undefined) item.interrupted = b.interrupted
	if (ts !== undefined) item.ts = ts
	return item
}

// Display items for one history record, going at `at`.
function recordItems(r: HistoryRecord, at: number): Item[] {
	let items =
		r.type === 'assistant'
			? transcript.blockItems([r.block], r.n === undefined ? undefined : [r.n], at, {
					model: r.model,
					effort: r.effort,
					ts: [r.ts],
					interrupted: r.interrupted,
				})
			: transcript.keyed(transcript.recordShown(r), r.n, at)
	return r.originSession === undefined ? items : items.map((item) => ({ ...item, originSession: r.originSession }))
}
function recordShown(r: HistoryRecord): Shown[] {
	if (r.type === 'rate_limit') return [{ type: 'output', text: r.text, ts: r.ts }]
	if (
		r.type === 'rebase' ||
		r.type === 'file_changes' ||
		r.type === 'round' ||
		r.type === 'continue' ||
		r.type === 'inbox' ||
		r.type === 'answer' ||
		r.type === 'notice' ||
		r.type === 'change' ||
		r.type === 'assistant'
	)
		return []
	if (r.type === 'question')
		return [{ type: 'question', id: r.id, form: r.form, ...(r.from && { command: true as const }), ts: r.ts }]
	if (
		(r.type === 'output' && r.transitionDone) ||
		((r.type === 'command' || r.type === 'output') && r.origin === 'model')
	)
		return [] // model-run: its tool card shows it (9g)
	if (r.type === 'command' || r.type === 'output') return [commandCards.aside(r)]
	if (r.type === 'reset') return [{ type: 'output', text: transcript.boundary(r), ts: r.ts }]
	if (r.type === 'compact') return [{ type: 'divider', text: transcript.boundary(r), ts: r.ts }]
	if (r.type === 'user')
		return r.blocks.flatMap((b): Shown[] =>
			b.type === 'text'
				? [transcript.promptItem(b.text, b, r.ts, r.replaces || r.amends !== undefined)]
				: b.type === 'image'
					? [transcript.imageItem(b, r.ts)]
					: transcript.resultItems(b, r.ts),
		)
	return [transcript.endItem(r)]
}
function endItem(end: { status: TurnStatus; usage?: Usage; error?: string; ts?: string }): Shown {
	let item: Shown = { type: 'turn-end', status: end.status }
	if (end.ts !== undefined) item.ts = end.ts
	if (end.usage && Object.keys(end.usage).length) item.usage = end.usage
	if (end.error !== undefined) item.error = end.error
	return item
}
function answered(
	items: Item[],
	answer: { question: string; answers: Answers; secrets?: string[]; canceled?: true },
): Item[] {
	return items.map((item) => {
		if (item.type !== 'question' || item.id !== answer.question) return item
		let done: Item = { ...item, answers: answer.answers }
		if (answer.secrets) done.secrets = answer.secrets
		if (answer.canceled) done.canceled = true
		return done
	})
}
function boundary(r: { type: 'compact'; prompts: number } | { type: 'reset' }): string {
	return r.type === 'reset'
		? 'Context cleared. `/clear undo` to go back.'
		: `Context compacted (${r.prompts} prompt${r.prompts === 1 ? '' : 's'} summarized). \`/compact undo\` to go back.`
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
	for (let r of [...early, ...history]) {
		if (replay.isPrompt(r)) prompt = items.length
		if (r.type === 'answer') items = transcript.answered(items, r)
		else if (r.type === 'rebase' && !r.quiet)
			items.push(
				...transcript.keyed(
					[{ type: 'divider', text: rebaseDisplay.text(r, snapshot.history), ts: r.ts }],
					r.n,
					items.length,
				),
			)
		else items.push(...transcript.recordItems(r, items.length))
	}
	let promptKey = items[prompt ?? -1]?.key
	items = commandCards.joined(transcriptOrder.order(items))
	items = rebaseDisplay.insert(items, snapshot.rewrites)
	let t: Transcript = { meta: { ...snapshot.meta }, state: snapshot.state, inbox: snapshot.inbox ?? [], items }
	if (prompt !== undefined) t.prompt = items.findIndex((item) => item.key === promptKey)
	if (snapshot.rewrites) t.rewrites = snapshot.rewrites
	if (snapshot.dropped) t.dropped = [...snapshot.dropped]
	if (snapshot.stats) t.stats = snapshot.stats
	if (snapshot.queueHold) t.queueHold = snapshot.queueHold
	if (early.length)
		t.earlier = transcript.fromSnapshot({ ...snapshot, history: early, earlier: [], turn: undefined }).items.length
	if (snapshot.turn) {
		let turn = transcriptLive.copyTurn(snapshot.turn)
		t.live = { start: items.length, turn }
		t.items = transcriptOrder.order([...items, ...transcriptLive.turnItems(turn, items.length)])
		t.live.start = Math.min(
			items.length,
			...(turn.ns?.map((n) => t.items.findIndex((item) => item.key === String(n))).filter((at) => at >= 0) ?? []),
		)
	}
	return snapshot.toolOutput ? transcriptLive.attach(t, snapshot.toolOutput) : t
}

// `t` with the items of `page`, the history just before `loaded` (the
// records `t` was folded from so far), in front, in place of any stand-
// ins for it: as if the snapshot had held page and loaded together.
// With `keep`, the stand-ins are from further back: they stay on top.
function prepend(t: Transcript, loaded: HistoryRecord[], page: HistoryRecord[], keep = false): Transcript {
	let base = { meta: t.meta, state: t.state, rewrites: t.rewrites }
	let full = transcript.fromSnapshot({ ...base, history: [...page, ...loaded] })
	let prefix: Item[] = full.items.slice(
		0,
		Math.max(0, full.items.length - transcript.fromSnapshot({ ...base, history: loaded }).items.length),
	)
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
		if (item.type === 'question' && item.answers)
			prefix = transcript.answered(prefix, {
				question: item.id,
				answers: item.answers,
				...(item.secrets ? { secrets: item.secrets } : {}),
				...(item.canceled ? { canceled: true as const } : {}),
			})
	}
	let shift = prefix.length - drop
	let { earlier: _earlier, ...out }: Transcript = { ...t, items: [...prefix, ...t.items.slice(drop)] }
	if (t.prompt !== undefined && t.prompt >= drop) out.prompt = t.prompt + shift
	else if (full.prompt !== undefined && full.prompt < prefix.length) out.prompt = full.prompt
	else delete out.prompt
	if (t.live) out.live = { start: t.live.start + shift, turn: t.live.turn }
	return out
}

export const transcript = {
	blockItems,
	promptItem,
	waitingItem,
	key,
	addressable,
	href,
	keyed,
	imageItem,
	resultItems,
	commitItem,
	resultItem,
	recordItems,
	recordShown,
	endItem,
	boundary,
	answered,
	question,
	standIns,
	fromSnapshot,
	prepend,
}
