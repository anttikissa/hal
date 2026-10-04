/// <reference lib="dom" />
// The session's transcript: one card per row (view.rows), keyed by the
// row's key (task w5), so a row keeps its DOM and whether it is open
// when a snapshot replaces every item, a streaming item grows, earlier
// history arrives above or a pending prompt lands; the open question as
// a form; the mark where replayed history ends; the prompts still
// pending, after the rows; and Hal's cursor, inside the card that
// streams (Card.tsx), else on a line of its own. The one scroller: Chat
// and scroll.ts keep a bottom reader at the bottom.

import { createMemo, createSignal, flush, For, onSettled, Show } from 'solid-js'
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
// rows when shown again.
const first = 40
const page = 60
const [counts, setCounts] = createSignal<ReadonlyMap<string, number>>(new Map())

// `target`: the block the address links to (target.ts), whose card is
// marked and opens.
export function Transcript(props: { view: ViewState; pending: Sending[]; target?: string; tabs?: Tab[] }) {
	let el!: HTMLElement
	let id = () => props.view.transcript?.meta.id ?? ''
	let count = () => counts().get(id()) ?? first
	// Nearing the top: rows already loaded first, then earlier history.
	let more = () => {
		if (count() >= all().length) return app.older()
		scroll.anchor(() => {
			setCounts(new Map(counts()).set(id(), count() + page))
			flush()
		})
	}
	onSettled(() => scroll.init(el, more))
	// Rows follow the items alone: redraws that leave them be (typing, the
	// status) keep every row object, so no card binding runs again.
	let items = createMemo(() => props.view.transcript?.items ?? none)
	let rows = createMemo(() => view.rows(items(), props.view.sent))
	let all = createMemo(() => view.withPending(rows(), props.pending, props.view.transcript?.inbox, props.tabs?.map((t) => t.id)))
	// The row Hal's cursor sits in: the last, while it streams.
	let streaming = createMemo(() => view.streaming(props.view))
	let cursorKey = () => (streaming() ? rows().at(-1)?.key : undefined)
	// Background jobs still running, by call key: their cards offer Kill.
	let jobs = createMemo(() => view.jobs(all()))
	// Prompts the user may edit and resend (task 26q): their cards offer Edit.
	let editable = createMemo(() => amend.editable(items()))
	let hit = createMemo(() => props.target && target.row(all(), props.target)?.key)
	// The linked card is always among the rows shown.
	let shown = createMemo(() => {
		let rows = all()
		let linked = hit() ? rows.findIndex((r) => r.key === hit()) : -1
		return rows.slice(Math.max(0, Math.min(rows.length - count(), linked < 0 ? rows.length : linked)))
	})
	let open = (row: Row) => (row.item.type === 'question' && props.view.form?.id === row.item.id ? row.item : undefined)
	return (
		<main class="Transcript" role="log" ref={(e) => (el = e)}>
			<For each={shown()} keyed={(row) => row.key}>
				{(row) => (
					<Show when={open(row())} fallback={<Card row={row()} session={props.view.transcript?.meta.id ?? ''} cursor={cursorKey() === row().key} target={hit() === row().key} job={jobs().has(row().item.key) ? row().item.key : undefined} edit={!row().pending && !row().waiting && editable().has(row().item.key)} />}>
						{(q) => <Question item={q()} form={props.view.form!} />}
					</Show>
				)}
			</For>
			<Show when={!streaming()}>
				<div class="cursor-line" aria-hidden="true">
					<span />
				</div>
			</Show>
		</main>
	)
}
