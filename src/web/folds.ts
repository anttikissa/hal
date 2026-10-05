// Which web cards are open or closed (tasks w5, r4d): kept by session
// and block key, not by the DOM, in memory only. Folding cards
// (thinking, tools, another session's message) start closed and are
// `opened`; assistant text and the user's prompts start open and are
// `closed` (/toggle names them one at a time). /toggle typed here and
// Ctrl-O flip cards locally and unrecorded, as in the terminal (task
// ghs); the model's /toggle arrives as an event.

import { createSignal, flush, untrack } from 'solid-js'
import { modals, type ModalState } from '../common/modals.ts'
import type { Key } from '../common/forms.ts'
import { forms } from '../common/forms.ts'
import type { Event } from '../common/protocol.ts'
import { toggle } from '../common/toggle.ts'
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
	untrack(() => (closes ? setClosed(toggled(closed(), id, !on)) : setOpened(toggled(opened(), id, on))))
	let hash = decodeURIComponent(location.hash.slice(1)).replace(/^[a-z](?=\d)/, '')
	if (!on && hash && keys.includes(hash)) {
		history.replaceState(history.state, '', location.pathname + location.search)
		app.aim()
	}
}

// Flips the cards `args` names in the session shown, as a click does.
// Returns why nothing was flipped, or undefined.
function run(args: string): string | undefined {
	let t = app.state.view.transcript
	let target = toggle.parse(args)
	if (typeof target === 'string' || !t) return typeof target === 'string' ? target : undefined
	let found = toggle.keys(t.items, target)
	if (typeof found === 'string') return found
	scroll.follow(() => {
		for (let key of found) {
			let item = t.items.find((i) => i.key === key)!
			let result = item.type === 'tool' ? t.items.find((i) => i.type === 'tool-result' && i.id === item.id)?.key : undefined
			folds.set(`${t.meta.id}#${key}`, item, !folds.isOpen(`${t.meta.id}#${key}`, item), result ? [key, result] : [key])
		}
		flush()
	}, 'track')
	return undefined
}

// Typed /toggle: true if `text` was one (and it ran).
function typed(text: string): boolean {
	let m = /^\/toggle(?:\s+(.*))?$/s.exec(text.trim())
	if (!m) return false
	let error = folds.run(m[1] ?? '')
	if (error) app.setNotice(error)
	return true
}

// The model's /toggle for the session shown: true if it was one.
function onEvent(event: Event): boolean {
	if (event.type !== 'toggle') return event.type === 'paste-text'
	if (event.sessionId === app.state.view.transcript?.meta.id) folds.run(event.target)
	return true
}

const examples = ['10-24   (toggle blocks 10-24)', '25   (you can also close an assistant message)', '#t24   (one tool call)', '(empty: the latest tool block)']

// Ctrl-O: the dialog asking which blocks to toggle.
function open(): void {
	if (!app.state.view.transcript) return
	let modal: ModalState = { compact: true, ...modals.open({ title: 'Toggle', hint: 'enter: toggle · esc: close', form: { text: 'Toggle', fields: [{ type: 'text', name: 'target', placeholder: examples }] } }) }
	app.setView({ ...app.state.view, modal })
}

// The dialog's field typed into.
function input(text: string): void {
	let m = app.state.view.modal
	if (m?.compact && m.form) app.setView({ ...app.state.view, modal: { ...m, form: forms.set(m.form, 0, text) } })
}

// A key on the dialog: Enter toggles, Escape closes.
function key(k: Key): void {
	let m = app.state.view.modal
	if (!m?.compact || (k.key !== 'enter' && k.key !== 'escape')) return
	app.setView({ ...app.state.view, modal: undefined })
	let error = k.key === 'enter' ? folds.run(m.form?.values[0] ?? '') : undefined
	if (error) app.setNotice(error)
}

export const folds = { opened, setOpened, closed, toggled, closable, isOpen, set, run, typed, onEvent, open, input, key, examples }
