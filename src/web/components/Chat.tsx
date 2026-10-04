/// <reference lib="dom" />
// The tab strip over the shown tab's conversation: the transcript above
// the message box, the model picker over both. app.ts holds the state;
// this mirrors it into a signal on every change (keeping a bottom
// reader at the bottom, and each tab's place: src/web/scroll.ts) and
// routes page keys, pastes and file drops to keys.ts. The page takes
// every file drag, so a dropped file never replaces it (task n5).

import { createMemo, createSignal, flush, Show, onSettled } from 'solid-js'
import { connection } from '../../common/connection.ts'
import type { Sending } from '../../common/drafts.ts'
import { notices } from '../../common/notices.ts'
import { app } from '../app.ts'
import { editor } from '../editor.ts'
import { keys, type Target } from '../keys.ts'
import { scroll } from '../scroll.ts'
import { push } from '../push.ts'
import { viewport } from '../viewport.ts'
import { Composer } from './Composer.tsx'
import { Notices } from './Notices.tsx'
import { Picker } from './Picker.tsx'
import { Rebase } from './Rebase.tsx'
import { Tabs } from './Tabs.tsx'
import { StatusRow } from './StatusRow.tsx'
import { Transcript } from './Transcript.tsx'

const snap = () => ({ target: app.state.target?.found && app.state.target.key, pages: app.state.pages, tabs: app.state.tabs, shown: app.state.shown, view: app.state.view, text: app.state.text, menu: app.state.menu, pending: app.pending(), notice: app.notice(), placeholder: app.placeholder(), connected: connection.connected(), pushReady: !!push.state.registration, notices: notices.state.entries, updateAvailable: app.state.updateAvailable })
type Snap = ReturnType<typeof snap>

// More new items than this at once are a catch-up, not news.
const catchUp = 8

// A change to the transcript follows the bottom: a new prompt pending
// (sent) glides to the very bottom, new items glide, streamed text
// jumps. Anything else (typing, the status) just redraws.
function redraw(before: Snap, set: (s: Snap) => void): void {
	let next = snap()
	let items = (s: Snap) => s.view.transcript?.items
	// Another tab's transcript: back to where the reader left it.
	let id = next.view.transcript?.meta.id
	if (id !== before.view.transcript?.meta.id) {
		scroll.quiet(() => {
			set(next)
			flush()
		})
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
	if (items(next) === items(before) && next.view.transcript?.inbox === before.view.transcript?.inbox && next.pending.length === before.pending.length) return set(next)
	let sent = next.pending.length > before.pending.length
	let added = (items(next)?.length ?? 0) + (next.view.transcript?.inbox.length ?? 0) - (items(before)?.length ?? 0) - (before.view.transcript?.inbox.length ?? 0)
	let grew = added > 0
	scroll.follow(
		() => {
			set(next)
			flush()
		},
		added > catchUp ? 'snap' : sent || grew ? 'glide' : 'jump',
		sent,
	)
}

// The linked block's card came: scroll to it once (the redraw that
// brought it may have moved the view, as a tab's first snapshot does).
function reveal(): void {
	let t = app.state.target
	if (!t?.found || t.shown) return
	flush()
	let card = document.querySelector('.Transcript .Card.target')
	if (!card) return
	t.shown = true
	scroll.stop()
	card.scrollIntoView({ block: 'start' })
}

function target(e: Event): Target {
	let t = e.target
	if (t instanceof HTMLTextAreaElement && !t.closest('dialog[open]')) {
		let back = t.selectionDirection === 'backward'
		let [cursor, anchor] = back ? [t.selectionStart, t.selectionEnd] : [t.selectionEnd, t.selectionStart]
		let coarse = matchMedia('(pointer: coarse)').matches
		return { kind: 'message', text: t.value, cursor, anchor, coarse, write: (edit, at, from) => editor.write(t, edit, at, from) }
	}
	// An open sheet keeps its keys (the box behind it is inert).
	if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || (t instanceof Element && t.closest('dialog[open], [contenteditable]'))) return { kind: 'field' }
	if (t instanceof HTMLAnchorElement) return { kind: 'link' }
	if (t instanceof HTMLButtonElement) return { kind: 'button', submits: t.type === 'submit' }
	return { kind: 'other' }
}

const same = (a: Sending[], b: Sending[]) => a.length === b.length && a.every((s, i) => s.id === b[i]!.id && s.text === b[i]!.text)

export function Chat() {
	let [state, setState] = createSignal(snap())
	// One memo per field, gated on its value, so a redraw reaches only
	// what changed: typing touches the composer, never the transcript.
	let field = <K extends keyof Snap>(k: K) => createMemo(() => state()[k])
	let [tabs, shown, view, text, menu, notice, placeholder, connected, linked, pushReady] = [field('tabs'), field('shown'), field('view'), field('text'), field('menu'), field('notice'), field('placeholder'), field('connected'), field('target'), field('pushReady')]
	let stack = field('notices')
	let updateAvailable = field('updateAvailable')
	let pending = createMemo(() => state().pending, { equals: same })
	// Files are dragged over the page: the box shows it takes them.
	let [dropping, setDropping] = createSignal(false)
	onSettled(() => {
		app.changed = () => {
			redraw(state(), setState)
			reveal()
		}
		notices.onChange = () => app.changed()
		let onKey = (e: KeyboardEvent) => {
			if (keys.key(e, target(e))) e.preventDefault()
			// Show the outcome now, not a microtask later.
			flush()
		}
		let onPaste = (e: ClipboardEvent) => {
			if (e.clipboardData && keys.paste(e.clipboardData, target(e))) e.preventDefault()
			flush()
		}
		let files = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files')
		let onDrag = (e: DragEvent) => {
			if (!files(e)) return
			e.preventDefault()
			e.dataTransfer!.dropEffect = 'copy'
			setDropping(true)
		}
		// Only leaving the window has no relatedTarget.
		let onLeave = (e: DragEvent) => !e.relatedTarget && setDropping(false)
		let onDrop = (e: DragEvent) => {
			setDropping(false)
			if (!files(e)) return
			e.preventDefault()
			keys.drop(e.dataTransfer!.files)
			flush()
		}
		let drags = [['dragover', onDrag], ['dragleave', onLeave], ['drop', onDrop]] as const
		for (let [k, f] of drags) document.addEventListener(k, f)
		document.addEventListener('keydown', onKey)
		document.addEventListener('paste', onPaste)
		let stop = viewport.sync(visualViewport ?? undefined, document.documentElement.style)
		app.start()
		return () => {
			document.removeEventListener('keydown', onKey)
			document.removeEventListener('paste', onPaste)
			for (let [k, f] of drags) document.removeEventListener(k, f)
			stop()
		}
	})
	return (
		<div class={['Chat', 'project', { offline: !connected() }]}>
			<Tabs tabs={tabs()} shown={shown()} pushReady={pushReady()} />
			<Show when={updateAvailable()}>
				<div class="source-update"><button type="button" aria-label="Reload to update Hal" onClick={() => location.reload()}>reload</button></div>
			</Show>
			<Transcript view={view()} pending={pending()} target={linked() || undefined} tabs={tabs()} />
			<Notices entries={stack()} />
			<StatusRow view={view()} connected={connected()} color={tabs().find((t) => t.id === shown())?.color} />
			<Composer view={view()} text={text()} menu={menu()} notice={notice()} placeholder={placeholder()} dropping={dropping()} />
			<Picker modal={view().modal} />
			<Rebase />
		</div>
	)
}
