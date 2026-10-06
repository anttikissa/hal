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

import { createEffect, createMemo, createSignal, For, Show, onSettled } from 'solid-js'
import { queueEdit } from '../../common/queue-edit.ts'
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
	let queueEditing = () => !!props.view.editing?.queueEdit
	let saving = () => !!props.view.transcript && !!queueEdit.current(props.view.transcript.meta.id)?.saving
	let canSave = () => !!props.view.transcript && queueEdit.ready(props.view.transcript.meta.id)
	let paused = () => props.view.transcript?.state.type === 'paused'
	let toggle = () => {
		let t = props.view.transcript
		if (t) app.sendNow(paused() ? { type: 'continue', sessionId: t.meta.id } : view.pause(props.view))
	}
	// One source per action button (task 02s): the icon, the small-caps
	// name under it, the aria-label and the caption that hover or
	// keyboard focus shows under the buttons on fine pointers.
	let [caption, setCaption] = createSignal('')
	let explains = matchMedia('(hover: hover) and (pointer: fine)')
	let Action = (p: { kind: keyof typeof BUTTONS; class?: string; disabled?: boolean; onClick: () => void }) => {
		let b = () => BUTTONS[p.kind]
		let show = () => explains.matches && setCaption(b().caption)
		return (
			<button type="button" class={p.class} aria-label={b().label} title={`${b().label} — ${b().caption}`} disabled={p.disabled} onPointerDown={(e) => e.preventDefault()} onPointerEnter={show} onFocus={show} onPointerLeave={() => setCaption('')} onBlur={() => setCaption('')} onClick={p.onClick}>
				<Icon name={b().icon} /><small>{b().name}</small>
			</button>
		)
	}
	// Interrupt delivery keeps the phone keyboard up for the next message;
	// Send and after-this-turn delivery hide it so the reply is visible.
	// A mouse keeps focus. The main button runs a command, steers a
	// running turn or sends a message.
	let action = (): keyof typeof BUTTONS => queueEditing() ? 'save' : view.commandDraft(props.text) ? 'run' : busy() ? 'steer' : 'send'
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
						    pointerdown, so scrolling and canceled touches remain harmless. */}
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
					<Icon name="plus" />
				</button>
				{/* Our own placeholder, so it can fade as typing starts. */}
				<div class="field">
				<span class={['hint', { gone: !!props.text }]} aria-hidden="true">{props.placeholder}</span>
				<textarea
					ref={box}
					rows={1}
					aria-label="Message"
					value={props.text}
					disabled={!!props.view.form || saving()}
					onInput={(e) => app.input(e.currentTarget.value)}
					onPaste={(e) => e.clipboardData && attach.paste(e.clipboardData, insert) && e.preventDefault()}
				/>
				</div>
				<div class="actions">
					{/* Pause and continue without Escape (task v0g); the tap keeps the keyboard. */}
					<Show when={busy() || paused()}>
						<Action kind={paused() ? 'continue' : 'pause'} class="toggle" onClick={toggle} />
					</Show>
					<Show when={busy() && !queueEditing() && !view.commandDraft(props.text)}>
						<Action kind="queue" disabled={!props.text.trim() || !!props.view.form} onClick={() => send(true)} />
					</Show>
					{/* The tap must not blur the draft before click: on iOS the blur
					    starts hiding the keyboard and moving the composer, and the
					    click was lost. send() blurs afterwards. */}
					<Action kind={action()} class="go" disabled={!props.text.trim() || !!props.view.form || (queueEditing() && !canSave())} onClick={() => send()} />
				</div>
				<Show when={caption()}><div class="caption" role="status">{caption()}</div></Show>
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

const BUTTONS = {
	pause: { icon: 'pause', name: 'Pause', label: 'Pause (Esc)', caption: 'Stop the turn for now. Continue resumes it.' },
	continue: { icon: 'play', name: 'Continue', label: 'Continue', caption: 'Resume the paused turn.' },
	queue: { icon: 'queue', name: 'Queue', label: 'Queue', caption: 'Sent after this turn ends.' },
	steer: { icon: 'steer', name: 'Steer', label: 'Steer', caption: 'Send message immediately. Interrupts ongoing work.' },
	send: { icon: 'send', name: 'Send', label: 'Send', caption: 'Send message to start a turn.' },
	run: { icon: 'run', name: 'Run', label: 'Run', caption: 'Run the command.' },
	save: { icon: 'send', name: 'Save', label: 'Save queued message', caption: 'Keep its place in the queue.' },
} satisfies Record<string, { icon: IconName; name: string; label: string; caption: string }>
