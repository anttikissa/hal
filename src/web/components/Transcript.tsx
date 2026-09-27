/// <reference lib="dom" />
// The session's transcript: one card per row (view.rows), keyed by
// position so a row keeps its DOM and whether it is open when a
// snapshot replaces every item or a streaming item grows; the open
// question as a form; the mark where replayed history ends; the
// prompts still pending; and Hal's cursor on a line of its own, dimmed
// while thinking streams. The one scroller: Chat and scroll.ts keep a
// bottom reader at the bottom.

import { createMemo, For, onSettled, Show } from 'solid-js'
import { transcript, type Item } from '../../common/transcript.ts'
import { app } from '../app.ts'
import { scroll } from '../scroll.ts'
import { view, type Row, type ViewState } from '../view.ts'
import { Card } from './Card.tsx'
import { Question } from './Question.tsx'

const none: Item[] = []

export function Transcript(props: { view: ViewState; pending: string[] }) {
	let el!: HTMLElement
	onSettled(() => scroll.init(el, () => app.older()))
	// Rows follow the items alone: redraws that leave them be (typing, the
	// status) keep every row object, so no card binding runs again.
	let items = createMemo(() => props.view.transcript?.items ?? none)
	let rows = createMemo(() => view.rows(items()))
	let markAt = () => (props.view.resumed ? view.markRow(rows(), props.view.resumed.at) : -1)
	let open = (row: Row) => (row.item.type === 'question' && props.view.form?.id === row.item.id ? row.item : undefined)
	let mark = () => <div class="log mark">{transcript.resumedLabel(props.view.resumed!)}</div>
	return (
		<main class="Transcript" role="log" ref={(e) => (el = e)}>
			<For each={rows()} keyed={false}>
				{(row, i) => (
					<>
						<Show when={markAt() === i}>{mark()}</Show>
						<Show when={open(row())} fallback={<Card row={row()} session={props.view.transcript?.meta.id ?? ''} />}>
							{(q) => <Question item={q()} form={props.view.form!} />}
						</Show>
					</>
				)}
			</For>
			<Show when={markAt() === rows().length}>{mark()}</Show>
			<For each={props.pending}>{(text) => <div class="Card user pending">{text}</div>}</For>
			<div class={['cursor-line', view.thinking(props.view) ? 'thinking' : 'assistant']} aria-hidden="true">
				<span />
			</div>
		</main>
	)
}
