/// <reference lib="dom" />
// The tab strip over the shown tab's conversation: the transcript above
// the message box, the model picker over both. app.ts holds the state;
// this mirrors it into a signal on every change (keeping a bottom
// reader at the bottom, and each tab's place: src/web/scroll.ts) and
// routes page keys and pastes to keys.ts.

import { createMemo, createSignal, flush, onSettled } from 'solid-js'
import { connection } from '../../common/connection.ts'
import { app } from '../app.ts'
import { editor } from '../editor.ts'
import { keys, type Target } from '../keys.ts'
import { scroll } from '../scroll.ts'
import { viewport } from '../viewport.ts'
import { Composer } from './Composer.tsx'
import { Picker } from './Picker.tsx'
import { Tabs } from './Tabs.tsx'
import { Transcript } from './Transcript.tsx'

const snap = () => ({ pages: app.state.pages, tabs: app.state.tabs, shown: app.state.shown, view: app.state.view, text: app.state.text, pending: app.pending(), notice: app.notice(), connected: connection.connected() })
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
		// A short transcript can't be scrolled up: fill the view first.
		if (scroll.atTop()) app.older()
		return
	}
	// Earlier history arrived above: what was being read stays put, and
	// a reader still near the top gets the page before.
	if (next.pages !== before.pages) {
		scroll.anchor(() => {
			set(next)
			flush()
		})
		if (scroll.atTop()) app.older()
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

function target(e: Event): Target {
	let t = e.target
	if (t instanceof HTMLTextAreaElement) {
		let back = t.selectionDirection === 'backward'
		let [cursor, anchor] = back ? [t.selectionStart, t.selectionEnd] : [t.selectionEnd, t.selectionStart]
		let coarse = matchMedia('(pointer: coarse)').matches
		return { kind: 'message', text: t.value, cursor, anchor, coarse, write: (edit, at, from) => editor.write(t, edit, at, from) }
	}
	// An open sheet keeps its keys (the box behind it is inert).
	if (t instanceof HTMLInputElement || (t instanceof Element && t.closest('dialog[open], [contenteditable]'))) return { kind: 'field' }
	if (t instanceof HTMLButtonElement || t instanceof HTMLAnchorElement) return { kind: 'button', submits: t instanceof HTMLButtonElement && t.type === 'submit' }
	return { kind: 'other' }
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((s, i) => s === b[i])

export function Chat() {
	let [state, setState] = createSignal(snap())
	// One memo per field, gated on its value, so a redraw reaches only
	// what changed: typing touches the composer, never the transcript.
	let field = <K extends keyof Snap>(k: K) => createMemo(() => state()[k])
	let [tabs, shown, view, text, notice, connected] = [field('tabs'), field('shown'), field('view'), field('text'), field('notice'), field('connected')]
	let pending = createMemo(() => state().pending, { equals: same })
	onSettled(() => {
		app.changed = () => redraw(state(), setState)
		let onKey = (e: KeyboardEvent) => {
			if (keys.key(e, target(e))) e.preventDefault()
			// Show the outcome now, not a microtask later.
			flush()
		}
		let onPaste = (e: ClipboardEvent) => {
			if (e.clipboardData && keys.paste(e.clipboardData, target(e))) e.preventDefault()
			flush()
		}
		document.addEventListener('keydown', onKey)
		document.addEventListener('paste', onPaste)
		let stop = viewport.sync(visualViewport ?? undefined, document.documentElement.style)
		app.start()
		return () => {
			document.removeEventListener('keydown', onKey)
			document.removeEventListener('paste', onPaste)
			stop()
		}
	})
	return (
		<div class="Chat">
			<Tabs tabs={tabs()} shown={shown()} />
			<Transcript view={view()} pending={pending()} />
			<Composer view={view()} text={text()} notice={notice()} connected={connected()} />
			<Picker modal={view().modal} />
		</div>
	)
}
