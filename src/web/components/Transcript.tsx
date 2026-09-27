/// <reference lib="dom" />
// The session's transcript: one card per row (view.rows), keyed by the
// row's key (task w5), so a row keeps its DOM and whether it is open
// when a snapshot replaces every item, a streaming item grows, earlier
// history arrives above or a pending prompt lands; the open question as
// a form; the mark where replayed history ends; the prompts still
// pending, after the rows; and Hal's cursor, inside the card that
// streams (Card.tsx), else on a line of its own. The one scroller: Chat
// and scroll.ts keep a bottom reader at the bottom.

import { createMemo, For, onSettled, Show } from 'solid-js'
import type { Sending } from '../../common/drafts.ts'
import type { Item } from '../../common/transcript.ts'
import { app } from '../app.ts'
import { scroll } from '../scroll.ts'
import { target } from '../target.ts'
import { view, type Row, type ViewState } from '../view.ts'
import { Card } from './Card.tsx'
import { Question } from './Question.tsx'

const none: Item[] = []

// `target`: the block the address links to (target.ts), whose card is
// marked and opens.
export function Transcript(props: { view: ViewState; pending: Sending[]; target?: string }) {
	let el!: HTMLElement
	onSettled(() => scroll.init(el, () => app.older()))
	// Rows follow the items alone: redraws that leave them be (typing, the
	// status) keep every row object, so no card binding runs again.
	let items = createMemo(() => props.view.transcript?.items ?? none)
	let rows = createMemo(() => view.rows(items(), props.view.sent))
	let all = createMemo(() => view.withPending(rows(), props.pending))
	// The row Hal's cursor sits in: the last, while it streams.
	let streaming = createMemo(() => view.streaming(props.view))
	let cursorAt = () => (streaming() ? rows().length - 1 : -1)
	let hit = createMemo(() => props.target && target.row(rows(), props.target)?.key)
	let open = (row: Row) => (row.item.type === 'question' && props.view.form?.id === row.item.id ? row.item : undefined)
	return (
		<main class="Transcript" role="log" ref={(e) => (el = e)}>
			<For each={all()} keyed={(row) => row.key}>
				{(row, i) => (
					<Show when={open(row())} fallback={<Card row={row()} session={props.view.transcript?.meta.id ?? ''} cursor={cursorAt() === i()} target={hit() === row().key} />}>
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
