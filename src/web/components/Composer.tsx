/// <reference lib="dom" />
// The bottom panel under the transcript: the messages waiting for the
// turn (the inbox), the passing notice, the message box with its Send
// button, and the key hints. Session activity lives in StatusRow. The box grows with its text up to 40% of
// the window. An open question or the model picker owns the keys
// meanwhile; the box keeps its text and takes the focus back when they
// close. Enter is handled by keys.key (none during IME composition).
// Images pasted, image and text files dropped on the page (Chat.tsx)
// or picked with the attach button, and long pasted text, become
// attachments (attach.ts): a placeholder at the caret, then the marker.
// While files are dragged over the page the box is outlined.

import { createEffect, For, Show } from 'solid-js'
import { states } from '../../common/states.ts'
import { app } from '../app.ts'
import { attach } from '../attach.ts'
import type { Menu } from '../completions.ts'
import { editor } from '../editor.ts'
import { keys } from '../keys.ts'
import { view, type ViewState } from '../view.ts'

export function Composer(props: { view: ViewState; text: string; menu?: Menu; notice: string | undefined; placeholder: string | undefined; dropping: boolean }) {
	let input!: HTMLTextAreaElement
	let picker!: HTMLInputElement
	// Text at the caret, replacing the selection, as if typed.
	let insert = (text: string) => editor.write(input, { start: input.selectionStart, end: input.selectionEnd, text }, input.selectionStart + text.length)
	// An upload's answer edits the box in place when it has the focus, so
	// the caret stays where the user is typing.
	let box = (e: HTMLTextAreaElement) => {
		input = e
		keys.insert = insert
		app.rewrite = (change) => {
			if (document.activeElement !== e) return app.input(change({ text: e.value, cursor: e.value.length }).text)
			let back = e.selectionDirection === 'backward'
			let [cursor, anchor] = back ? [e.selectionStart, e.selectionEnd] : [e.selectionEnd, e.selectionStart]
			let p = change({ text: e.value, cursor, anchor }) as { text: string; cursor: number; anchor?: number }
			editor.write(e, editor.splice(e.value, p.text), p.cursor, p.anchor ?? p.cursor)
		}
	}
	createEffect(
		() => props.text,
		() => {
			input.style.height = 'auto'
			// CSS caps content height against the changing visual viewport.
			input.style.height = `${input.scrollHeight + 2}px`
		},
	)
	createEffect(
		() => !!props.view.form || !!props.view.modal,
		(away) => {
			// Touch navigation is for reading; only deliberate editing opens the keyboard.
			if (!away && !matchMedia('(pointer: coarse)').matches) input.focus()
		},
	)
	let busy = () => !!props.view.transcript && states.busy(props.view.transcript.state)
	let send = (queue = false) => {
		app.send(queue)
		input.focus()
	}
	return (
		<footer class="Composer">
			<div id="notice" class="log">
				{props.notice ?? ''}
			</div>
			<div class={['entry input', { dropping: props.dropping }]}>
				{props.menu && (
					<div class="completions" role="listbox" aria-label="Completions">
						<For each={props.menu.choices}>{(choice, index) => (
							<button type="button" role="option" aria-selected={props.menu?.selected === index() ? 'true' : 'false'} onClick={() => { app.choose(index()); input.focus() }}>
								<strong>{choice.label}</strong><span>{choice.description}</span>
							</button>
						)}</For>
					</div>
				)}
				{/* Our own placeholder, so it can fade as typing starts. */}
				<div class="field">
				<span class={['hint', { gone: !!props.text }]} aria-hidden="true">{props.placeholder}</span>
				<textarea
					ref={box}
					rows={1}
					aria-label="Message"
					value={props.text}
					disabled={!!props.view.form}
					onInput={(e) => app.input(e.currentTarget.value)}
					onPaste={(e) => e.clipboardData && attach.paste(e.clipboardData, insert) && e.preventDefault()}
				/>
				</div>
				<input
					ref={(e) => (picker = e)}
					type="file"
					accept={attach.accept}
					multiple
					hidden
					onChange={(e) => {
						attach.files(e.currentTarget.files ?? [], insert)
						// The same file may be picked again.
						e.currentTarget.value = ''
					}}
				/>
				<button type="button" aria-label="Attach file" title="Attach file" disabled={!!props.view.form} onClick={() => picker.click()}>
					+
				</button>
				<div class="actions">
					<button type="button" disabled={!props.text.trim() || !!props.view.form} onClick={() => send()}>
						{busy() ? 'Steer' : 'Send'}
					</button>
					<Show when={busy()}>
						<button type="button" disabled={!props.text.trim() || !!props.view.form} onClick={() => send(true)}>Queue</button>
					</Show>
				</div>
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
