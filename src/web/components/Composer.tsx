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
// Above the box, each attachment marker in the text is a chip (task
// a4): a real link (so the browser's own cmd-click and context menu
// work; text in a textarea can never be a link) with an × that deletes
// the marker as an undoable edit. The text stays the only state.

import { createEffect, createMemo, For, Show, onSettled } from 'solid-js'
import { attachments } from '../../common/attachments.ts'
import { states } from '../../common/states.ts'
import { uploads } from '../../common/uploads.ts'
import { app } from '../app.ts'
import { attach } from '../attach.ts'
import type { Menu } from '../completions.ts'
import { editor } from '../editor.ts'
import { keys } from '../keys.ts'
import { view, type ViewState } from '../view.ts'
import { Icon } from './Icon.tsx'
import type { IconName } from '../icons.ts'

export function Composer(props: { view: ViewState; text: string; menu?: Menu; notice: string | undefined; placeholder: string | undefined; dropping: boolean }) {
	let input!: HTMLTextAreaElement
	// Text at the caret, replacing the selection, as if typed.
	let insert = (text: string) => {
		text = uploads.pad(text, input.value.slice(0, input.selectionStart))
		editor.write(input, { start: input.selectionStart, end: input.selectionEnd, text }, input.selectionStart + text.length)
	}
	// An upload's answer edits the box in place when it has the focus, so
	// the caret stays where the user is typing.
	let picker!: HTMLInputElement
	let typing = false
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
	// A memo gates on equality: the effect runs only when a form or the
	// picker opens or closes, never on other updates, so the focus never
	// moves while the reader selects text.
	let away = createMemo(() => !!props.view.form || !!props.view.modal)
	createEffect(
		away,
		(away) => {
			// Touch navigation is for reading; only deliberate editing opens the keyboard.
			if (!away && !matchMedia('(pointer: coarse)').matches) input.focus()
		},
	)
	onSettled(() => {
		let inside = (t: EventTarget | null) => t === input || (t instanceof Element && !!t.closest('.Composer .completions'))
		let outside = (e: PointerEvent | FocusEvent) => { if (!inside(e.target)) app.dismissMenu() }
		let leaving = (e: FocusEvent) => { if (inside(e.target) && !inside(e.relatedTarget)) app.dismissMenu() }
		document.addEventListener('pointerdown', outside, true)
		document.addEventListener('focusin', outside)
		document.addEventListener('focusout', leaving)
		// A click inside a dialog moves the page selection into its text;
		// closing it gives the box focus back without a caret, so keys
		// vanish (task 6cm). Refocusing restores the caret.
		let closed = () => { if (document.activeElement === input) { input.blur(); input.focus() } }
		document.addEventListener('close', closed, true)
		return () => {
			document.removeEventListener('close', closed, true)
			document.removeEventListener('pointerdown', outside, true)
			document.removeEventListener('focusin', outside)
			document.removeEventListener('focusout', leaving)
		}
	})
	// Marker paths ('image/abc123.png'): strings, so For keeps each chip's
	// node (and its loaded thumbnail) while typing elsewhere.
	let chips = createMemo(() => [...props.text.matchAll(attachments.fileMarker)].map((m) => m[1]!))
	// Deletes the index-th marker and one space after it, the caret kept
	// on the same text.
	let remove = (index: number) => {
		let m = [...input.value.matchAll(attachments.fileMarker)][index]
		if (!m) return
		let start = m.index, end = start + m[0].length + (input.value[start + m[0].length] === ' ' ? 1 : 0)
		let c = input.selectionStart
		editor.write(input, { start, end, text: '' }, c >= end ? c - (end - start) : Math.min(c, start))
	}
	// A thumbnail asked for before its upload finished is a 404: retry.
	let retry = (img: HTMLImageElement) => {
		let n = Number(img.dataset.tries ?? 0)
		if (n < 20) setTimeout(() => ((img.dataset.tries = String(n + 1)), (img.src = `${img.src.split('?')[0]}?try=${n + 1}`)), 500)
	}
	let busy = () => !!props.view.transcript && states.busy(props.view.transcript.state)
	let paused = () => props.view.transcript?.state.type === 'paused'
	let toggle = () => {
		let t = props.view.transcript
		if (t) app.sendNow(paused() ? { type: 'continue', sessionId: t.meta.id } : view.pause(props.view))
	}
	// Steering keeps the phone keyboard up for the next steer; Send and
	// Queue hide it so the reply is visible. A mouse keeps the focus.
	// The main button's icon, name and tooltip: run a command, steer a
	// running turn or send.
	let action = (): [IconName, string, string] => view.commandDraft(props.text) ? ['run', 'Run', 'Run command'] : busy() ? ['steer', 'Steer', 'Steer: send now, into this turn'] : ['send', 'Send', 'Send']
	let send = (queue = false) => {
		let steer = busy() && !queue
		app.send(queue)
		if (steer || !matchMedia('(pointer: coarse)').matches) input.focus()
		else input.blur()
	}
	return (
		<footer class="Composer">
			<div id="notice" class="log">
				{props.notice ?? ''}
			</div>
			<Show when={chips().length}>
				<ul class="chips" aria-label="Attachments">
					<For each={chips()}>{(path, index) => {
						let name = path.split('/')[1]!
						return (
							<li>
								<a href={`/${path}`} target="_blank" rel="noopener" title={`Open ${path}`}>
									{path.startsWith('image/') ? <img src={`/raw/${name}`} alt={path} onLoad={(e) => (e.currentTarget.dataset.loaded = '')} onError={(e) => retry(e.currentTarget)} /> : path}
								</a>
								<button type="button" aria-label={`Remove ${path}`} title="Remove" onClick={() => remove(index())}><Icon name="close" /></button>
							</li>
						)
					}}</For>
				</ul>
			</Show>
			<div class={['entry input', { dropping: props.dropping }]}>
				{props.menu && (
					<div class="completions" role="listbox" aria-label="Completions">
						{/* Keep the editor focused: iOS may blur without focusing the button,
						    dismissing the menu before its click. Choose only on click, not
						    pointerdown, so scrolling and cancelled touches remain harmless. */}
						<For each={props.menu.choices}>{(choice, index) => (
							<button type="button" role="option" aria-selected={props.menu?.selected === index() ? 'true' : 'false'} onPointerDown={(e) => e.preventDefault()} onClick={() => { app.choose(index()); input.focus() }}>
								<strong>{choice.label}</strong><span>{choice.description}</span>
							</button>
						)}</For>
					</div>
				)}
				<input
					type="file"
					class="hidden-text"
					tabindex={-1}
					aria-hidden="true"
					accept={attach.accept}
					multiple
					onChange={(e) => {
						attach.files(e.currentTarget.files ?? [], insert)
						e.currentTarget.value = ''
						if (typing) input.focus()
					}}
					ref={(e) => { picker = e; e.addEventListener('cancel', () => { if (typing) input.focus() }) }}
				/>
				{/* Keep the keyboard: the tap leaves the draft focused, and the
				    draft takes the focus back when the picker closes. */}
				<button type="button" class="attach" aria-label="Attach file" title="Attach file" disabled={!!props.view.form} onPointerDown={(e) => { typing = document.activeElement === input; e.preventDefault() }} onClick={() => picker.click()}>
					<Icon name="attach" />
				</button>
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
				<div class="actions">
					{/* Pause and continue without Escape (task v0g); the tap keeps the keyboard. */}
					<Show when={busy() || paused()}>
						<button type="button" class="toggle" aria-label={paused() ? 'Continue' : 'Pause (Esc)'} title={paused() ? 'Continue' : 'Pause (Esc)'} onPointerDown={(e) => e.preventDefault()} onClick={toggle}>
							<Icon name={paused() ? 'play' : 'pause'} />
						</button>
					</Show>
					<Show when={busy() && !view.commandDraft(props.text)}>
						<button type="button" disabled={!props.text.trim() || !!props.view.form} onPointerDown={(e) => e.preventDefault()} aria-label="Queue" title="Queue: send after this turn" onClick={() => send(true)}><Icon name="queue" /></button>
					</Show>
					{/* The tap must not blur the draft before click: on iOS the blur
					    starts hiding the keyboard and moving the composer, and the
					    click was lost. send() blurs afterwards. */}
					<button type="button" class="go" aria-label={action()[1]} title={action()[2]} disabled={!props.text.trim() || !!props.view.form} onPointerDown={(e) => e.preventDefault()} onClick={() => send()}>
						<Icon name={action()[0]} />
					</button>
				</div>
			</div>
			<div class="help">
				<For each={view.hints(props.view, props.text, props.menu)}>
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
