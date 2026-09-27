/// <reference lib="dom" />
// The session's transcript: one block per shown item (settled items
// keep their nodes across folds), the open question as a form, the
// mark where replayed history ends, then the prompts still pending.
// Stays at the bottom while the user has it scrolled there.

import { createEffect, For, Show } from 'solid-js'
import { transcript, type Item } from '../../common/transcript.ts'
import { view, type ViewState } from '../view.ts'
import { Question } from './Question.tsx'

export function Transcript(props: { view: ViewState; pending: string[] }) {
	let el!: HTMLElement
	let stuck = true
	let items = () => props.view.transcript?.items ?? []
	let open = (item: Item) => (item.type === 'question' && props.view.form?.id === item.id ? item : undefined)
	let resumedAt = (i: number) => props.view.resumed?.at === i
	createEffect(
		() => [items(), props.pending, props.view.resumed, props.view.form],
		() => {
			if (stuck) el.scrollTop = el.scrollHeight
		},
	)
	let entry = (item: Item) => {
		let shown = view.show(item)
		return shown && <div class={shown.kind}>{shown.text}</div>
	}
	let mark = () => <div class="log">{transcript.resumedLabel(props.view.resumed!)}</div>
	return (
		<main class="Transcript" role="log" ref={(e) => (el = e)} onScroll={() => (stuck = view.atBottom(el))}>
			<For each={items()}>
				{(item, i) => (
					<>
						<Show when={resumedAt(i())}>{mark()}</Show>
						<Show when={open(item)} fallback={entry(item)}>
							{(q) => <Question item={q()} form={props.view.form!} />}
						</Show>
					</>
				)}
			</For>
			<Show when={resumedAt(items().length)}>{mark()}</Show>
			<For each={props.pending}>{(text) => <div class="user pending">{text}</div>}</For>
		</main>
	)
}
