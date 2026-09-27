/// <reference lib="dom" />
// Under the transcript: the messages waiting for the turn (the inbox),
// the passing notice, and the message box, which grows with its text
// up to a third of the window. An open question or the model picker
// owns the keys meanwhile; the box keeps its text and takes the focus
// back when they close.

import { createEffect, For } from 'solid-js'
import { app } from '../app.ts'
import { view, type ViewState } from '../view.ts'

export function Composer(props: { view: ViewState; text: string; notice: string | undefined }) {
	let input!: HTMLTextAreaElement
	createEffect(
		() => props.text,
		() => {
			input.style.height = 'auto'
			input.style.height = `${Math.min(input.scrollHeight + 2, innerHeight / 3)}px`
		},
	)
	createEffect(
		() => !!props.view.form || !!props.view.modal,
		(away) => {
			if (!away) input.focus()
		},
	)
	let placeholder = () => {
		let status = view.status(props.view)
		return status ? `${status}; Enter steers, Alt+Enter queues, Escape pauses` : 'Message Hal (Enter sends, Shift+Enter for a newline)'
	}
	return (
		<footer class="Composer">
			<div class="inbox">
				<For each={view.inbox(props.view)}>{(m) => <div class="log">{`${m.label}: ${m.text}`}</div>}</For>
			</div>
			<div id="notice" class="log">
				{props.notice ?? ''}
			</div>
			<textarea
				ref={(e) => (input = e)}
				class="input"
				rows={1}
				aria-label="Message"
				value={props.text}
				disabled={!!props.view.form}
				placeholder={placeholder()}
				onInput={(e) => app.input(e.currentTarget.value)}
			/>
		</footer>
	)
}
