/// <reference lib="dom" />
// One session's conversation: the transcript above the message box,
// the model picker over both. app.ts holds the state; this mirrors it
// into a signal on every change and routes page keys to app.key.

import { createSignal, flush, onSettled } from 'solid-js'
import { app, type Target } from '../app.ts'
import { Composer } from './Composer.tsx'
import { Picker } from './Picker.tsx'
import { Transcript } from './Transcript.tsx'

const snap = () => ({ view: app.state.view, text: app.state.text, pending: app.pending(), notice: app.notice() })

function target(e: KeyboardEvent): Target {
	let t = e.target
	if (t instanceof HTMLTextAreaElement) return { kind: 'message', text: t.value, caretAtEnd: t.selectionStart === t.value.length }
	if (t instanceof HTMLInputElement) return { kind: 'field' }
	if (t instanceof HTMLButtonElement) return { kind: 'button', submits: t.type === 'submit' }
	return { kind: 'other' }
}

export function Chat() {
	let [state, setState] = createSignal(snap())
	onSettled(() => {
		app.changed = () => setState(snap())
		let onKey = (e: KeyboardEvent) => {
			if (app.key(e, target(e))) e.preventDefault()
			// Show the outcome now, not a microtask later.
			flush()
		}
		document.addEventListener('keydown', onKey)
		app.start()
		return () => document.removeEventListener('keydown', onKey)
	})
	return (
		<div class="Chat">
			<Transcript view={state().view} pending={state().pending} />
			<Composer view={state().view} text={state().text} notice={state().notice} />
			<Picker modal={state().view.modal} />
		</div>
	)
}
