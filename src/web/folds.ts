// Which web cards are open or closed (tasks w5, r4d, v8y): kept by session
// and block key, not by the DOM, in memory only. Folding cards
// (thinking, tools, another session's message) start closed and are
// `opened`; assistant text and the user's prompts start open and are
// `closed` (/toggle names them). /toggle, /expand and
// /collapse typed here and Ctrl-O change cards locally and unrecorded,
// as in the terminal (task ghs); the model's command arrives as an event.

import { createSignal, flush, untrack } from 'solid-js'
import type { ModalState } from '../common/modals.ts'
import type { Key } from '../common/forms.ts'
import { forms } from '../common/forms.ts'
import type { Event } from '../common/protocol.ts'
import { toggle, type Fold, type Mode } from '../common/toggle.ts'
import { blocksDialog } from '../common/blocks-dialog.ts'
import type { Item } from '../common/transcript.ts'
import { app } from './app.ts'
import { scroll } from './scroll.ts'

const [opened, setOpened] = createSignal<ReadonlySet<string>>(new Set())
const [closed, setClosed] = createSignal<ReadonlySet<string>>(new Set())

function toggled(set: ReadonlySet<string>, id: string, on: boolean): ReadonlySet<string> {
	let next = new Set(set)
	if (on) next.add(id)
	else next.delete(id)
	return next
}

// Whether `item`'s card starts open and closes (text and the user's
// prompts), rather than starting closed.
function closable(item: Item): boolean {
	return item.type === 'text' || (item.type === 'prompt' && !item.summary)
}

// Whether card `id` (`<session>#<key>`) of `item` shows open.
function isOpen(id: string, item: Item): boolean {
	return folds.closable(item) ? !closed().has(id) : opened().has(id)
}

// Opens or closes card `id`; closing the card the address names drops
// the address's #block without a new history entry.
// `closes`: the card starts open (a queued row's note never does).
function set(id: string, item: Item, on: boolean, keys: string[] = [item.key], closes = folds.closable(item)): void {
	// The updater sees earlier sets of the same batch (/expand t*).
	untrack(() => (closes ? setClosed((s) => toggled(s, id, !on)) : setOpened((s) => toggled(s, id, on))))
	let hash = decodeURIComponent(location.hash.slice(1)).replace(/^[a-z](?=\d)/, '')
	if (!on && hash && keys.includes(hash)) {
		history.replaceState(history.state, '', location.pathname + location.search)
		app.aim()
	}
}

// Card `item`'s state in session `sid`, as the shared rules see it.
function fold(sid: string, item: Item): Fold {
	return folds.isOpen(`${sid}#${item.key}`, item) ? 'open' : 'closed'
}

// Applies `mode` with `args` to the cards of the session shown, as
// clicks do. Returns why nothing changed, or undefined.
function run(args: string, mode: Mode = 'toggle'): string | undefined {
	let t = app.state.view.transcript
	if (!t) return undefined
	let at = (i: Item) => folds.fold(t.meta.id, i)
	let p = toggle.plan(mode, t.items, args, at)
	if (typeof p === 'string') return p
	scroll.follow(() => {
		for (let item of p.items) {
			let result = item.type === 'tool' ? t.items.find((i) => i.type === 'tool-result' && i.id === item.id)?.key : undefined
			folds.set(`${t.meta.id}#${item.key}`, item, p.open ?? at(item) === 'closed', result ? [item.key, result] : [item.key])
		}
		flush()
	}, 'track')
	return undefined
}

// Typed /toggle, /expand or /collapse: true if `text` was one (and it ran).
function typed(text: string): boolean {
	let m = /^\/(toggle|expand|collapse)(?:\s+(.*))?$/s.exec(text.trim())
	if (!m) return false
	let error = folds.run(m[2] ?? '', m[1] as Mode)
	if (error) app.setNotice(error)
	return true
}

// The model's command for the session shown: true if it was one.
function onEvent(event: Event): boolean {
	if (event.type !== 'toggle') return event.type === 'paste-text'
	if (event.sessionId === app.state.view.transcript?.meta.id) folds.run(event.target, event.mode)
	return true
}

// The dialog `m` with the hint for the session shown.
function hinted(m: ModalState): ModalState {
	let t = app.state.view.transcript
	return t ? blocksDialog.update(m, t.items, (i) => folds.fold(t.meta.id, i)) : m
}

// Ctrl-O: the "Expand or collapse blocks" dialog (task v8y).
function open(): void {
	if (!app.state.view.transcript) return
	app.setView({ ...app.state.view, modal: folds.hinted(blocksDialog.open()) })
}

// The dialog's field typed into: a new hint, Tab's list gone.
function input(text: string): void {
	let m = app.state.view.modal
	if (m?.compact && m.form) app.setView({ ...app.state.view, modal: folds.hinted({ ...m, form: forms.set(m.form, 0, text) }) })
}

// A key on the dialog: Enter runs /toggle, Escape closes, Tab
// completes the block id before `cursor`.
function key(k: Key, cursor?: number): void {
	let m = app.state.view.modal, t = app.state.view.transcript
	if (!m?.compact) return
	if (k.key === 'tab') {
		if (!t) return
		let next = blocksDialog.complete(m, t.items, (i) => folds.fold(t.meta.id, i), cursor)
		app.setView({ ...app.state.view, modal: next })
		// The caret stays after the completed id, not at the end.
		let field = document.activeElement
		if (field instanceof HTMLInputElement) { flush(); field.setSelectionRange(next.form!.cursor, next.form!.cursor) }
		return
	}
	if (k.key !== 'enter' && k.key !== 'escape') return
	app.setView({ ...app.state.view, modal: undefined })
	let error = k.key === 'enter' ? folds.run(m.form?.values[0] ?? '') : undefined
	if (error) app.setNotice(error)
}

export const folds = { opened, setOpened, closed, toggled, closable, isOpen, set, fold, run, typed, onEvent, hinted, open, input, key }
