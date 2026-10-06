/// <reference lib="dom" />
// The session's transcript: one card per row (view.rows), keyed by the
// row's key (task w5), so a row keeps its DOM and whether it is open
// when a snapshot replaces every item, a streaming item grows, earlier
// history arrives above or a pending prompt lands; the open question as
// a form; the mark where replayed history ends; the prompts still
// pending, after the rows; and Hal's cursor, inside the card that
// streams (Card.tsx), else on a line of its own. The one scroller: Chat
// and scroll.ts keep a bottom reader at the bottom.

import { createEffect, createMemo, createSignal, flush, For, onSettled, Show, untrack } from 'solid-js'
import type { Sending } from '../../common/drafts.ts'
import type { Tab } from '../../common/protocol.ts'
import { amend } from '../../common/amend.ts'
import type { Item } from '../../common/transcript.ts'
import { app } from '../app.ts'
import { scroll } from '../scroll.ts'
import { target } from '../target.ts'
import { view, type Row, type ViewState } from '../view.ts'
import { Card } from './Card.tsx'
import { Question } from './Question.tsx'

const none: Item[] = []

// A tab shows its newest rows first: building every card of a long
// session takes most of a second. Earlier rows are added a page at a
// time as the reader nears the top, per session so a tab keeps its
// rows when shown again. The first shown row is kept by key, so new
// rows only add below: a row once shown never leaves the top, and text
// a reader is reading or selecting never moves.
const first = 40
const page = 60
const [starts, setStarts] = createSignal<ReadonlyMap<string, string>>(new Map())

// `target`: the block the address links to (target.ts), whose card is
// marked and opens.
export function Transcript(props: { view: ViewState; pending: Sending[]; target?: string; tabs?: Tab[] }) {
	let el!: HTMLElement
	let id = () => props.view.transcript?.meta.id ?? ''
	// Index of the first shown row; set once per session, then moved
	// only up.
	let start = () => {
		let rows = all(), key = starts().get(id())
		let i = key === undefined ? -1 : rows.findIndex((r) => r.key === key)
		return i >= 0 ? i : Math.max(0, rows.length - first)
	}
	let setStart = (i: number) => untrack(() => {
		let key = all()[i]?.key
		if (key !== undefined && starts().get(id()) !== key) setStarts(new Map(starts()).set(id(), key))
	})
	// Nearing the top: rows already loaded first, then earlier history.
	let more = () => {
		if (start() === 0) return app.older()
		scroll.anchor(() => {
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
	onSettled(() => {
		el.addEventListener('scroll', check, { passive: true })
		return () => el.removeEventListener('scroll', check)
	})
	// Rows follow the items alone: redraws that leave them be (typing, the
	// status) keep every row object, so no card binding runs again.
	let items = createMemo(() => props.view.transcript?.items ?? none)
	let rows = createMemo(() => view.rows(items(), props.view.sent))
	let all = createMemo(() => view.withPending(rows(), props.pending, props.view.transcript?.inbox, props.tabs?.map((t) => t.id), props.view.transcript?.queueHold))
	// The row Hal's cursor sits in: the last, while it streams.
	let streaming = createMemo(() => view.streaming(props.view))
	let cursorKey = () => (streaming() ? rows().at(-1)?.key : undefined)
	// Otherwise its own line after the last row, before waiting and
	// pending messages: the cursor is the work now, they the future.
	let line = () => (
		<div class="cursor-line" aria-hidden="true">
			<span />
		</div>
	)
	// Background jobs still running, by call key: their cards offer Kill.
	let jobs = createMemo(() => view.jobs(all()))
	// Prompts the user may edit and resend (task 26q): their cards offer Edit.
	// One queued message is edited at a time, in one window.
	let editableWaiting = (r: Row) => !props.view.transcript?.queueHold && r.note !== undefined && r.item.type === 'prompt' && r.item.from === undefined && r.item.origin !== 'model'
	let editable = createMemo(() => amend.editable(items()))
	let hit = createMemo(() => props.target && target.row(all(), props.target)?.key)
	// The linked card is always among the rows shown.
	let shown = createMemo(() => {
		let rows = all()
		let linked = hit() ? rows.findIndex((r) => r.key === hit()) : -1
		return rows.slice(Math.max(0, Math.min(start(), linked < 0 ? rows.length : linked)))
	})
	// Pin the first shown row once the tab has rows.
	createEffect(() => (all().length && !starts().has(id()) ? start() : -1), (i) => void (i >= 0 && setStart(i)))
	createEffect(shown, () => void requestAnimationFrame(check))
	let open = (row: Row) => (row.item.type === 'question' && props.view.form?.id === row.item.id ? row.item : undefined)
	return (
		<main class="Transcript" role="log" ref={(e) => (el = e)}>
			<For each={shown()} keyed={(row) => row.key}>
				{(row) => (
					<>
					<Show when={open(row())} fallback={<Card row={row()} session={props.view.transcript?.meta.id ?? ''} cursor={cursorKey() === row().key} target={hit() === row().key} job={jobs().has(row().item.key) ? row().item.key : undefined} edit={!row().pending && (row().waiting ? editableWaiting(row()) : editable().has(row().item.key))} />}>
						{(q) => <Question item={q()} form={props.view.form!} session={props.view.transcript?.meta.id ?? ''} />}
					</Show>
					<Show when={!streaming() && row().key === rows().at(-1)?.key}>{line()}</Show>
					</>
				)}
			</For>
			<Show when={!streaming() && !rows().length}>{line()}</Show>
			<div class="to-bottom">
				<Show when={away()}>
					<button type="button" aria-label="Scroll to the bottom" title="Scroll to the bottom" onPointerDown={(e) => e.preventDefault()} onClick={() => scroll.follow(() => {}, 'glide', true)}>
						<span class="pill"><svg viewBox="0 0 12 16" aria-hidden="true"><path d="M1 1h10L6 7zM1 8h10l-5 6z" /></svg></span>
					</button>
				</Show>
			</div>
		</main>
	)
}
