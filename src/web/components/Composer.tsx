/// <reference lib="dom" />
// The bottom panel under the transcript: the messages waiting for the
// turn (the inbox), the passing notice, a status line like the
// terminal's (a pulsing dot while busy), the message box with its Send
// button, and the key hints. The box grows with its text up to 40% of
// the window. An open question or the model picker owns the keys
// meanwhile; the box keeps its text and takes the focus back when they
// close. Enter is handled by app.key (none during IME composition).

import { createEffect, For } from 'solid-js'
import { app } from '../app.ts'
import { view, type ViewState } from '../view.ts'

export function Composer(props: { view: ViewState; text: string; notice: string | undefined; connected: boolean }) {
	let input!: HTMLTextAreaElement
	createEffect(
		() => props.text,
		() => {
			input.style.height = 'auto'
			input.style.height = `${Math.min(input.scrollHeight + 2, innerHeight * 0.4)}px`
		},
	)
	createEffect(
		() => !!props.view.form || !!props.view.modal,
		(away) => {
			if (!away) input.focus()
		},
	)
	let line = () => view.line(props.view, props.connected)
	let tone = () => ({ idle: '', busy: 'busy', warn: 'warning', error: 'error' })[line().tone]
	let send = () => {
		app.send()
		input.focus()
	}
	return (
		<footer class="Composer">
			<div class="inbox">
				<For each={view.inbox(props.view)}>{(m) => <div class="log">{`${m.label}: ${m.text}`}</div>}</For>
			</div>
			<div id="notice" class="log">
				{props.notice ?? ''}
			</div>
			<div class="status" aria-live="polite">
				<span class={['dot', tone()]} aria-hidden="true">
					●
				</span>{' '}
				<span class={tone()}>{line().text}</span>
			</div>
			<div class="entry input">
				<textarea
					ref={(e) => (input = e)}
					rows={1}
					aria-label="Message"
					value={props.text}
					disabled={!!props.view.form}
					onInput={(e) => app.input(e.currentTarget.value)}
				/>
				<button type="button" disabled={!props.text.trim() || !!props.view.form} onClick={send}>
					Send
				</button>
			</div>
			<div class="help">
				<For each={view.hints(props.view)}>
					{(h) => (
						<span>
							<b>{h[0]}</b> {h[1]}
						</span>
					)}
				</For>
			</div>
		</footer>
	)
}
