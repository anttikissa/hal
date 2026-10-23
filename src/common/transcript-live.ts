// Folding live events (src/common/protocol.ts) into a transcript
// (transcript.ts), and the running turn they stream into. A client
// following live events shows what a later snapshot would. Tasks: ca, 6eq.

import { commandCards } from './command-cards.ts'
import { blocks } from './blocks.ts'
import type { Event } from './protocol.ts'
import type { LiveTurn } from './snapshot.ts'
import { transcript, type Item, type Shown, type Streamed, type Transcript } from './transcript.ts'
import { transcriptOrder } from './transcript-order.ts'

// A live turn's blocks as items going at `at`.
function turnItems(turn: LiveTurn, at: number): Item[] {
	return transcript.blockItems(turn.blocks, turn.ns, at, turn)
}

// A copy that blocks.apply may mutate without touching the original:
// apply only ever changes the last block and the usage.
function copyTurn(turn: LiveTurn): LiveTurn {
	let list = turn.blocks.slice()
	let last = list.at(-1)
	if (last) list[list.length - 1] = { ...last }
	let copy: LiveTurn = { ...transcriptLive.fresh(turn), blocks: list, usage: { ...turn.usage } }
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
	if (event.type === 'snapshot' || event.type === 'history-rewritten')
		return t && t.meta.id !== event.sessionId ? t : transcript.fromSnapshot(event.snapshot)
	if (
		!t ||
		!('sessionId' in event) ||
		event.type === 'rejected' ||
		event.type === 'draft' ||
		event.sessionId !== t.meta.id
	)
		return t
	if (event.type === 'state') return { ...t, state: event.state }
	if (event.type === 'queue-hold') {
		let { queueHold: _hold, ...rest } = t
		return event.message ? { ...rest, queueHold: event.message } : rest
	}
	if (event.type === 'inbox') return { ...t, inbox: event.inbox }
	if (event.type === 'answer') return { ...t, items: transcript.answered(t.items, event) }
	if (event.type === 'meta')
		return transcriptLive.endedJobs({ ...t, meta: { ...event.meta }, ...(event.stats && { stats: event.stats }) })
	if (event.type === 'turn-stats') return { ...t, stats: event.stats }
	if (event.type === 'turn-end' && event.stats) t = { ...t, stats: event.stats }
	if (event.type === 'assistant-interrupted') {
		let items = t.live ? transcriptLive.settle(t.items, t.live) : t.items
		items = transcriptOrder.order([
			...items.filter((item) => item.key !== String(event.record.n)),
			...transcript.recordItems(event.record, items.length),
		])
		return { ...t, items, ...(t.live && { live: { start: items.length, turn: transcriptLive.fresh(t.live.turn) } }) }
	}
	if (event.type === 'tool-output') {
		let job =
			t.jobOutput?.[event.id] ??
			(transcriptLive.jobCalls(t).some((item) => item.id === event.id) ? { output: '', from: 0 } : undefined)
		if (job) {
			let grown = transcriptLive.grow(job, event.at, event.chunk)
			return grown ? { ...t, jobOutput: { ...t.jobOutput, [event.id]: grown } } : t
		}
		let changed = false
		let items = t.items.map((item): Item => {
			if (item.type !== 'tool' || item.id !== event.id) return item
			let grown = transcriptLive.grow(
				{ output: item.partial ?? '', from: item.partialFrom ?? 0 },
				event.at,
				event.chunk,
			)
			if (!grown) return item
			changed = true
			return { ...item, partial: grown.output, ...(grown.from && { partialFrom: grown.from }) }
		})
		return changed ? { ...t, items } : t
	}
	if (
		event.type === 'completions' ||
		event.type === 'history' ||
		((event.type === 'command' || event.type === 'output') && event.origin === 'model')
	)
		return t
	// A command's question is an aside too: it never ends the turn.
	if (event.type === 'divider' && event.clear && !t.live) {
		let { prompt: _p, earlier: _e, ...rest } = t
		return { ...rest, items: transcript.keyed([commandCards.aside(event)], event.n, 0) }
	}
	if (
		event.type === 'command' ||
		event.type === 'output' ||
		event.type === 'divider' ||
		(event.type === 'question' && event.command)
	) {
		let added = transcript.keyed([commandCards.aside(event)], event.n, t.items.length)
		let last = t.items.at(-1)
		if (last && commandCards.joins(last, added[0]!))
			return { ...t, items: [...t.items.slice(0, -1), commandCards.join(last, added[0]!)] }
		return { ...t, items: [...t.items, ...added] }
	}
	if (event.type === 'turn-start') {
		if (event.prompt === undefined) return { ...t, live: { start: t.items.length, turn: transcriptLive.fresh(event) } }
		let items: Item[] = [
			...t.items,
			...transcript.keyed(
				[
					transcript.promptItem(event.prompt, event.sender, event.ts),
					...(event.images ?? []).map((b) => transcript.imageItem(b, event.ts)),
				],
				event.n,
				t.items.length,
			),
		]
		return { ...t, items, prompt: t.items.length, live: { start: items.length, turn: transcriptLive.fresh(event) } }
	}
	let question: Shown | undefined =
		event.type === 'question'
			? { type: 'question', id: event.id, form: event.form, ...(event.ts !== undefined && { ts: event.ts }) }
			: undefined
	let ended = (items: Item[], end: Shown): Item[] => [
		...items,
		...transcript.keyed([end], (event as { n?: number }).n, items.length),
	]
	// A turn left unfinished by another host ends without running here.
	if (!t.live) {
		if (event.type === 'turn-end') return { ...t, items: ended(t.items, transcript.endItem(event)) }
		if (event.type === 'prompt') return transcriptLive.prompted(t, t.items, event)
		return question ? { ...t, items: ended(t.items, question) } : t
	}
	let settled = t.items.slice(0, t.live.start)
	if (event.type === 'prompt') {
		// The round's blocks are in history before the prompt.
		let next = transcriptLive.prompted(t, transcriptLive.settle(t.items, t.live), event)
		return { ...next, live: { start: next.items.length, turn: transcriptLive.fresh(t.live.turn) } }
	}
	if (event.type === 'stream') {
		let live = t.live
		if (event.model !== undefined && (event.model !== live.turn.model || event.effort !== live.turn.effort)) {
			settled = transcriptLive.settle(t.items, live)
			live = {
				start: settled.length,
				turn: transcriptLive.fresh({ provider: event.model.split('/')[0]!, model: event.model, effort: event.effort }),
			}
		}
		let turn = transcriptLive.copyTurn(live.turn)
		blocks.apply(turn, event.event)
		while (turn.ns && event.n !== undefined && turn.ns.length < turn.blocks.length) turn.ns.push(event.n)
		if (!turn.ns && event.n !== undefined && turn.blocks.length) turn.ns = turn.blocks.map(() => event.n!)
		// A block's start time comes with its first event.
		while (event.ts !== undefined && (turn.ts ??= []).length < turn.blocks.length) turn.ts.push(event.ts)
		let items = transcriptOrder.replace(
			live === t.live ? t.items : settled,
			live.start,
			transcriptLive.turnItems(live.turn, live.start),
			transcriptLive.turnItems(turn, live.start),
		)
		return { ...t, items, live: { start: live.start, turn } }
	}
	if (event.type === 'tool-results') {
		// The round's blocks are in history now; the next round starts empty.
		// A call that went to the background moves its output apart.
		let jobs = transcriptLive.jobKeys(t)
		let jobOutput = t.jobOutput
		let done = transcriptLive.settle(t.items, t.live).map((item): Item => {
			if (item.type !== 'tool' || !event.results.some((r) => r.id === item.id)) return item
			if (jobs.has(item.key) && !jobOutput?.[item.id])
				jobOutput = { ...jobOutput, [item.id]: { output: item.partial ?? '', from: item.partialFrom ?? 0 } }
			let { partial: _p, partialFrom: _f, ...rest } = item
			return rest
		})
		let items = [
			...done,
			...transcript.keyed(
				event.results.flatMap((b) => transcript.resultItems(b, event.ts)),
				event.n,
				done.length,
			),
		]
		return {
			...t,
			...(jobOutput && { jobOutput }),
			items,
			live: { start: items.length, turn: transcriptLive.fresh(t.live.turn) },
		}
	}
	// Attachments, notices and other session events are not turn ends.
	if (event.type !== 'question' && event.type !== 'turn-end') return t
	// Asking stops the running turn: its output is in history.
	let end = question ?? transcript.endItem(event as Event & { type: 'turn-end' })
	let { live: _live, ...rest } = t
	return { ...rest, items: ended(transcriptLive.settle(t.items, t.live), end) }
}

// The items with the live turn's blocks settled as history has them.
function settle(items: Item[], live: NonNullable<Transcript['live']>): Item[] {
	return transcriptOrder.replace(
		items,
		live.start,
		transcriptLive.turnItems(live.turn, live.start),
		transcriptLive.turnItems(live.turn, live.start),
	)
}

// After `items`, a prompt event's texts; an edit (`replaces`) takes
// the place of the last prompt and everything after it.
function prompted(t: Transcript, items: Item[], event: Event & { type: 'prompt' }): Transcript {
	let at = event.amends === undefined ? t.prompt : items.findIndex((i) => i.key === String(event.amends))
	let keep =
		event.replaces && at !== undefined && at >= 0
			? items.filter(
					(i, index) =>
						index < at || (i.type === 'output' && i.change !== undefined) || (i.type === 'text' && i.synthetic),
				)
			: items
	let { live: _live, ...rest } = t
	let shown: Shown[] = [
		...event.texts.map((text, i) =>
			transcript.promptItem(text, event.senders?.[i], event.ts, event.replaces || event.amends !== undefined),
		),
		...(event.images ?? []).map((b) => transcript.imageItem(b, event.ts)),
	]
	return { ...rest, items: [...keep, ...transcript.keyed(shown, event.n, keep.length)], prompt: keep.length }
}

// Keys of this session's Bash calls whose background job still runs
// (task 6nn): the host lists them in meta as `<session>:<n>`.
function jobKeys(t: Transcript): Set<string> {
	let prefix = `${t.meta.id}:`
	return new Set((t.meta.background ?? []).filter((id) => id.startsWith(prefix)).map((id) => id.slice(prefix.length)))
}

// The calls of running background jobs.
function jobCalls(t: Transcript): (Item & { type: 'tool' })[] {
	let keys = transcriptLive.jobKeys(t)
	if (!keys.size) return []
	return t.items.filter((item): item is Item & { type: 'tool' } => item.type === 'tool' && keys.has(item.key))
}

// The calls of running background jobs with their output, streaming at
// the bottom. An unchanged job gives the same object, so cards keep.
const shown = new WeakMap<object, { call: Item; item: Item & { type: 'tool' } }>()
function jobItems(t: Transcript): (Item & { type: 'tool' })[] {
	return transcriptLive.jobCalls(t).map((call) => {
		let out = t.jobOutput?.[call.id]
		if (!out) return call
		let seen = shown.get(out)
		if (seen?.call === call) return seen.item
		let item = { ...call, partial: out.output, ...(out.from && { partialFrom: out.from }) }
		shown.set(out, { call, item })
		return item
	})
}

// Raises `s` by `chunk`, sent at offset `at`; undefined when it adds
// nothing or leaves a gap. Like the host, keeps only the newest output.
function grow(s: Streamed, at: number, chunk: string): Streamed | undefined {
	let end = s.from + s.output.length
	let added = chunk.slice(Math.max(0, end - at))
	if (!added || at > end) return undefined
	let output = s.output + added
	let from = s.from
	let max = transcriptLive.partialMax
	if (output.length > 2 * max) {
		from += output.length - max
		output = output.slice(-max)
	}
	return { output, from }
}

// `t` with a snapshot's output in flight: on its call, or apart for a
// background job, whose call card must not change.
function attach(t: Transcript, outputs: (Streamed & { id: string })[]): Transcript {
	let partial = new Map(outputs.map((p) => [p.id, p]))
	let jobs = transcriptLive.jobKeys(t)
	let jobOutput = t.jobOutput
	let items = t.items.map((item) => {
		let p = item.type === 'tool' ? partial.get(item.id) : undefined
		if (!p || item.type !== 'tool') return item
		if (!jobs.has(item.key)) return { ...item, partial: p.output, ...(p.from && { partialFrom: p.from }) }
		jobOutput = { ...jobOutput, [item.id]: { output: p.output, from: p.from } }
		return item
	})
	return { ...t, items, ...(jobOutput && { jobOutput }) }
}

// Drops the output of jobs that ended.
function endedJobs(t: Transcript): Transcript {
	if (!t.jobOutput) return t
	let running = new Set(transcriptLive.jobCalls(t).map((c) => c.id))
	let kept = Object.entries(t.jobOutput).filter(([id]) => running.has(id))
	if (kept.length === Object.keys(t.jobOutput).length) return t
	let { jobOutput: _j, ...rest } = t
	return kept.length ? { ...rest, jobOutput: Object.fromEntries(kept) } : rest
}

export const transcriptLive = {
	turnItems,
	copyTurn,
	fresh,
	fold,
	settle,
	prompted,
	jobKeys,
	jobCalls,
	jobItems,
	grow,
	attach,
	endedJobs,
	partialMax: 1_000_000,
}
