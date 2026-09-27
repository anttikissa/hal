/// <reference lib="dom" />
// The tab strip over the shown tab's conversation: the transcript above
// the message box, the model picker over both. app.ts holds the state;
// this mirrors it into a signal on every change (keeping a bottom
// reader at the bottom, and each tab's place: src/web/scroll.ts) and
// routes page keys to app.key.

import { createSignal, flush, onSettled } from 'solid-js'
import { connection } from '../../common/connection.ts'
import { app, type Target } from '../app.ts'
import { editor } from '../editor.ts'
import { scroll } from '../scroll.ts'
import { Composer } from './Composer.tsx'
import { Picker } from './Picker.tsx'
import { Tabs } from './Tabs.tsx'
import { Transcript } from './Transcript.tsx'

const snap = () => ({ tabs: app.state.tabs, shown: app.state.shown, view: app.state.view, text: app.state.text, pending: app.pending(), notice: app.notice(), connected: connection.connected() })
type Snap = ReturnType<typeof snap>

// A change to the transcript follows the bottom: a new prompt pending
// (sent) glides to the very bottom, new items glide, streamed text
// jumps. Anything else (typing, the status) just redraws.
function redraw(before: Snap, set: (s: Snap) => void): void {
	let next = snap()
	let items = (s: Snap) => s.view.transcript?.items
	// Another tab's transcript: back to where the reader left it.
	let id = next.view.transcript?.meta.id
	if (id !== before.view.transcript?.meta.id) {
		set(next)
		flush()
		if (id) scroll.restore(id)
		return
	}
	if (items(next) === items(before) && next.pending.length === before.pending.length) return set(next)
	let sent = next.pending.length > before.pending.length
	let grew = (items(next)?.length ?? 0) > (items(before)?.length ?? 0)
	scroll.follow(
		() => {
			set(next)
			flush()
		},
		sent || grew ? 'glide' : 'jump',
		sent,
	)
}

function target(e: KeyboardEvent): Target {
	let t = e.target
	if (t instanceof HTMLTextAreaElement) {
		let back = t.selectionDirection === 'backward'
		let [cursor, anchor] = back ? [t.selectionStart, t.selectionEnd] : [t.selectionEnd, t.selectionStart]
		return { kind: 'message', text: t.value, cursor, anchor, write: (edit, at, from) => editor.write(t, edit, at, from) }
	}
	if (t instanceof HTMLInputElement) return { kind: 'field' }
	if (t instanceof HTMLButtonElement) return { kind: 'button', submits: t.type === 'submit' }
	return { kind: 'other' }
}

export function Chat() {
	let [state, setState] = createSignal(snap())
	onSettled(() => {
		app.changed = () => redraw(state(), setState)
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
			<Tabs tabs={state().tabs} shown={state().shown} />
			<Transcript view={state().view} pending={state().pending} />
			<Composer view={state().view} text={state().text} notice={state().notice} connected={state().connected} />
			<Picker modal={state().view.modal} />
		</div>
	)
}
