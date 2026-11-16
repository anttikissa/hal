/// <reference lib="dom" />
// The session's transcript: one card per row (transcriptRows.rows), keyed by the
// row's key (task w5), so a row keeps its DOM and whether it is open
// when a snapshot replaces every item, a streaming item grows, earlier
// history arrives above or a pending prompt lands; the open question as
// a form; the mark where replayed history ends; the prompts still
// pending, after the rows; and Hal's cursor, inside the card that
// streams (Card.tsx), else on a line of its own. The one scroller: the
// browser keeps a bottom reader at the bottom (scroll.ts).

import {
	createEffect,
	createMemo,
	createProjection,
	createSignal,
	flush,
	For,
	onSettled,
	Show,
	untrack,
} from 'solid-js'
import type { SessionMeta } from '../../common/session.ts'
import type { Sending } from '../../common/drafts.ts'
import type { Tab } from '../../common/protocol.ts'
import { amend } from '../../common/amend.ts'
import { forms } from '../../common/forms.ts'
import { toolDetails } from '../../common/tool-details.ts'
import { transcript, type Item } from '../../common/transcript.ts'
import { transcriptLive } from '../../common/transcript-live.ts'
import { app } from '../app.ts'
import { scroll } from '../scroll.ts'
import { target } from '../target.ts'
import { view, type ViewState } from '../view.ts'
import { transcriptRows, type Row } from '../transcript-rows.ts'
import { Card } from './Card.tsx'
import { Question } from './Question.tsx'

const none: Item[] = []
const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((k) => b.has(k))
// A row's marks, bits in Transcript's `marks`.
const CURSOR = 1,
	LAST = 2,
	TARGET = 4,
	JOB = 8,
	EDIT = 16,
	DISCARD = 32,
	RUNNING = 64
type Shared = { session: string; blocks?: SessionMeta['blocks']; formId?: string; since?: string }

// A tab shows its newest rows first: building every card of a long
// session takes most of a second. Earlier rows are added a page at a
// time as the reader nears the top, per session so a tab keeps its
// rows when shown again. The first shown row is kept by key, so new
// rows only add below: a row once shown never leaves the top, and text
// a reader is reading or selecting never moves.
const first = 40
const page = 60
const [starts, setStarts] = createSignal<ReadonlyMap<string, string>>(new Map())

// Session `id`'s tab is shown again. Read at the bottom, it starts over
// from its newest rows: rows a long turn added while it was shown would
// otherwise all be built again (ADEMark A11 took 10 s to switch).
export function reopened(id: string): void {
	if ((scroll.state.places.get(id) ?? 0) < -1 || !starts().has(id)) return
	let next = new Map(starts())
	next.delete(id)
	setStarts(next)
}

// `target`: the block the address links to (target.ts), whose card is
// marked and opens.
export function Transcript(props: { view: ViewState; pending: Sending[]; target?: string; tabs?: Tab[] }) {
	let el!: HTMLElement
	let id = () => props.view.transcript?.meta.id ?? ''
	// Index of the first shown row; set once per session, then moved
	// only up.
	let start = () => {
		let rows = all(),
			key = starts().get(id())
		let i = key === undefined ? -1 : rows.findIndex((r) => r.key === key)
		return i >= 0 ? i : Math.max(0, rows.length - first)
	}
	let setStart = (i: number) =>
		untrack(() => {
			let key = all()[i]?.key
			if (key !== undefined && starts().get(id()) !== key) setStarts(new Map(starts()).set(id(), key))
		})
	// Nearing the top: rows already loaded first, then earlier history.
	let more = () => {
		if (start() === 0) return app.older()
		scroll.quiet(() => {
			setStart(Math.max(0, start() - page))
			flush()
		})
	}
	onSettled(() => scroll.init(el, more))
	// Scrolled well above the bottom: a pill on the cards' bar takes the
	// reader back down. Checked on scroll and when rows change, since
	// content growing below a still reader moves the bottom away.
	let [away, setAway] = createSignal(false)
	let check = () => el && setAway(scroll.gap(el) > scroll.awayPx)
	// Headers stick only on blocks over 10 lines tall, of every kind, and
	// only while they fit in a third of the transcript: a long open title
	// pinned at the top would hide the body scrolling under it.
	let tall = new ResizeObserver((entries) => {
		for (let { target } of entries) {
			let block = target as HTMLElement
			let head = block.querySelector<HTMLElement>(':scope .CardHeader:not(.inline)')
			let fits = !head || head.offsetHeight <= el.clientHeight / 3
			block.toggleAttribute(
				'data-tall',
				fits && block.offsetHeight > 10 * parseFloat(getComputedStyle(block).lineHeight),
			)
		}
	})
	onSettled(() => {
		el.addEventListener('scroll', check, { passive: true })
		return () => el.removeEventListener('scroll', check)
	})
	// Rows follow the items alone: redraws that leave them be (typing, the
	// status) keep every row object, so no card binding runs again.
	let items = createMemo(() => (props.view.transcript ? transcript.shown(props.view.transcript) : none))
	let rows = createMemo<Row[]>((before) => transcriptRows.rows(items(), props.view.sent, before))
	let tabIds = createMemo(() => props.tabs?.map((t) => t.id), {
		equals: (a, b) => a?.length === b?.length && (a?.every((id, i) => id === b?.[i]) ?? true),
	})
	let jobCalls = createMemo(() => (props.view.transcript ? transcriptLive.jobItems(props.view.transcript) : none), {
		equals: (a, b) => a.length === b.length && a.every((item, i) => item === b[i]),
	})
	let all = createMemo(() =>
		transcriptRows.withPending(
			rows(),
			props.pending,
			props.view.transcript?.inbox,
			tabIds(),
			props.view.transcript?.queueHold,
			jobCalls(),
		),
	)
	// The row Hal's cursor sits in: the last, while it streams.
	let streaming = createMemo(() => view.streaming(props.view))
	let lastKey = createMemo(() => rows().at(-1)?.key)
	// The call the session runs now: its card ticks (task hyt).
	let running = createMemo(
		() => {
			let st = props.view.transcript?.state
			return st?.type === 'running' && st.phase === 'tools' && st.call ? { call: st.call, since: st.since } : undefined
		},
		{ equals: (a, b) => a?.call === b?.call && a?.since === b?.since },
	)
	// Otherwise its own line after the last row, before waiting and
	// pending messages: the cursor is the work now, they the future.
	let line = () => (
		<div class="cursor-line" aria-hidden="true">
			<span />
		</div>
	)
	// Background jobs still running, by call key: their cards offer Kill.
	let jobs = createMemo(() => transcriptRows.jobs(all()), { equals: sameSet })
	// Prompts the user may edit and resend (task 26q): their cards offer Edit.
	// One queued message is edited at a time, in one window.
	let editableWaiting = (r: Row, held: string | undefined) =>
		!held && r.note !== undefined && r.item.type === 'prompt' && r.item.from === undefined && r.item.origin !== 'model'
	let editable = createMemo(() => amend.editable(items()), { equals: sameSet })
	let hit = createMemo(() => props.target && target.row(all(), props.target)?.key)
	// What cards read, as stores: a card subscribes to its own row's
	// marks and to shared leaves, never to a memo of props.view. Every
	// streamed event replaces props.view, and Solid marks each node
	// downstream of it, so one read of such a memo per card made each
	// event cost O(rows). A store notifies only readers of the keys that
	// changed (createProjection, Solid 2's createSelector).
	let shared = createProjection<Shared>(
		(draft) => {
			draft.session = id()
			draft.blocks = forms.cards(props.view.form, props.view.transcript?.meta.blocks)
			draft.formId = props.view.form?.id
			draft.since = running()?.since
		},
		{ session: '' },
	)
	let marks = createProjection<Record<string, number>>((draft) => {
		let next = new Map<string, number>()
		let add = (key: string | undefined | false, bit: number) =>
			key !== undefined && key !== false && next.set(key, (next.get(key) ?? 0) | bit)
		let call = running()?.call,
			held = props.view.transcript?.queueHold,
			edits = editable(),
			busy = jobs()
		add(lastKey(), streaming() ? CURSOR : LAST)
		add(hit(), TARGET)
		for (let r of all()) {
			if (busy.has(r.item.key)) add(r.key, JOB)
			if (!r.pending && (r.waiting ? editableWaiting(r, held) : edits.has(r.item.key))) add(r.key, EDIT)
			if (r.note !== undefined && r.key !== held) add(r.key, DISCARD)
			if (call && !r.job && r.item.type === 'tool' && r.item.id === call) add(r.key, RUNNING)
		}
		for (let key of Object.keys(draft)) if (!next.has(key)) delete draft[key]
		for (let [key, bits] of next) if (draft[key] !== bits) draft[key] = bits
	}, {})
	let marked = (key: string, bit: number) => !!((marks[key] ?? 0) & bit)
	// The linked card is always among the rows shown.
	let shown = createMemo(() => {
		let rows = all()
		let linked = hit() ? rows.findIndex((r) => r.key === hit()) : -1
		return rows.slice(Math.max(0, Math.min(start(), linked < 0 ? rows.length : linked)))
	})
	// Pin the first shown row once the tab has rows.
	createEffect(
		() => (all().length && !starts().has(id()) ? start() : -1),
		(i) => void (i >= 0 && setStart(i)),
	)
	// New cards only: observing every card again on each streamed event
	// re-measured them all.
	let added = new MutationObserver((records) => {
		for (let { addedNodes } of records)
			for (let node of addedNodes)
				if (node instanceof HTMLElement && node.matches('.Card, .Question')) tall.observe(node)
	})
	onSettled(() => {
		let list = el.querySelector(':scope > .rows')!
		for (let block of list.querySelectorAll(':scope > :is(.Card, .Question)')) tall.observe(block)
		added.observe(list, { childList: true })
		return () => added.disconnect()
	})
	// One check a frame, however many events arrive in it.
	let frame = 0
	createEffect(shown, () => {
		frame ||= requestAnimationFrame(() => {
			frame = 0
			check()
		})
	})
	let open = (row: Row) => (row.item.type === 'question' && shared.formId === row.item.id ? row.item : undefined)
	let waiting = (title: string) => toolDetails.waiting(title, props.view.transcript?.meta.id ?? '', items(), props.tabs)
	return (
		<main class="Transcript" role="log" ref={(e) => (el = e)}>
			<div class="to-bottom">
				<Show when={away()}>
					<button
						type="button"
						aria-label="Scroll to the bottom"
						title="Scroll to the bottom"
						onPointerDown={(e) => e.preventDefault()}
						onClick={scroll.bottom}
					>
						<span class="pill">
							<svg viewBox="0 0 12 16" aria-hidden="true">
								<path d="M1 1h10L6 7zM1 8h10l-5 6z" />
							</svg>
						</span>
					</button>
				</Show>
			</div>
			<div class="rows">
				<For each={shown()} keyed={(row) => row.key}>
					{(row) => {
						let cursor = createMemo(() => marked(row().key, CURSOR))
						let last = createMemo(() => marked(row().key, LAST))
						return (
							<>
								<Show
									when={open(row())}
									fallback={
										<Card
											row={row()}
											session={shared.session}
											blocks={shared.blocks}
											running={
												row().job
													? { call: (row().item as { id: string }).id, since: row().item.ts }
													: marked(row().key, RUNNING)
														? { call: (row().item as { id: string }).id, since: shared.since }
														: undefined
											}
											cursor={cursor()}
											target={marked(row().key, TARGET)}
											job={marked(row().key, JOB) ? row().item.key : undefined}
											edit={marked(row().key, EDIT)}
											discard={marked(row().key, DISCARD)}
											waiting={waiting}
										/>
									}
								>
									{(q) => (
										<Question
											item={q()}
											form={props.view.form!}
											session={shared.session}
											target={marked(row().key, TARGET)}
										/>
									)}
								</Show>
								<Show when={last()}>{line()}</Show>
							</>
						)
					}}
				</For>
				<Show when={!streaming() && !rows().length}>{line()}</Show>
			</div>
		</main>
	)
}
