// How much of each web card shows (tasks w5, r4d, v8y, hyt): short,
// glimpse or long, kept by session and block key, not by the DOM, in
// memory only. A card starts as the session sets its kind
// (card.initial); a click, /toggle, /expand, /collapse and Ctrl-O
// change it locally and unrecorded, as in the terminal (task ghs); the
// model's command arrives as an event.

import { createSignal, flush, untrack } from 'solid-js'
import type { ModalState } from '../common/modals.ts'
import type { Key } from '../common/forms.ts'
import { forms } from '../common/forms.ts'
import type { Event } from '../common/protocol.ts'
import { toggle, type Fold, type Mode } from '../common/toggle.ts'
import { blocksDialog } from '../common/blocks-dialog.ts'
import type { Item, Transcript } from '../common/transcript.ts'
import { app } from './app.ts'
import { scroll } from './scroll.ts'

const [states, setStates] = createSignal<ReadonlyMap<string, Fold>>(new Map())
const [raw, setRaw] = createSignal<ReadonlySet<string>>(new Set())

function toggled(set: ReadonlySet<string>, id: string, on: boolean): ReadonlySet<string> {
	let next = new Set(set)
	if (on) next.add(id)
	else next.delete(id)
	return next
}

// Card `id`'s (`<session>#<key>`) state, `start` until changed here.
function level(id: string, start: Fold): Fold {
	return states().get(id) ?? start
}

// Sets card `id`; collapsing the card the address names drops the
// address's #block without a new history entry. `keys`: the blocks
// the card shows (a call and its result).
function set(id: string, fold: Fold, keys: string[]): void {
	// The updater sees earlier sets of the same batch (/expand t*).
	untrack(() => setStates((s) => new Map(s).set(id, fold)))
	let hash = decodeURIComponent(location.hash.slice(1)).replace(/^[a-z](?=\d)/, '')
	if (fold === 'short' && hash && keys.includes(hash)) {
		history.replaceState(history.state, '', location.pathname + location.search)
		app.aim()
	}
}

// The states of `t`'s cards, as the shared rules see them; one per use.
function at(t: Transcript): (item: Item) => Fold {
	let start = toggle.starts(t)
	return (item) => folds.level(`${t.meta.id}#${item.key}`, start(item))
}

// Applies `mode` with `args` to the cards of the session shown, as
// clicks do. Returns why nothing changed, or undefined.
function run(args: string, mode: Mode = 'toggle'): string | undefined {
	let t = app.state.view.transcript
	if (!t) return undefined
	let at = folds.at(t)
	let p = toggle.plan(mode, toggle.items(t), args, at)
	if (typeof p === 'string') return p
	scroll.follow(() => {
		for (let item of p.items) {
			let result = item.type === 'tool' ? t.items.find((i) => i.type === 'tool-result' && i.id === item.id)?.key : undefined
			let next = toggle.step(item, at(item), p.open, false)
			setRaw((s) => toggled(s, `${t.meta.id}#${item.key}`, next === 'inline'))
			folds.set(`${t.meta.id}#${item.key}`, next, result ? [item.key, result] : [item.key])
		}
		flush()
	})
	return undefined
}

// Typed /toggle, /expand or /collapse: true if `text` was one (and it ran).
function typed(text: string): boolean {
	let m = /^\/(toggle|expand|collapse)(?:\s+(.*))?$/is.exec(text.trim())
	if (!m) return false
	let error = folds.run(m[2] ?? '', m[1]!.toLowerCase() as Mode)
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
	return t ? blocksDialog.update(m, toggle.items(t), folds.at(t), false) : m
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
		let next = blocksDialog.complete(m, toggle.items(t), folds.at(t), cursor, false)
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

export const folds = { raw, setRaw, toggled, level, set, at, run, typed, onEvent, hinted, open, input, key }
