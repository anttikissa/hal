// Modals: client-only UI over the conversation (model picker, /login,
// /config, find), never in history; each ends in an ordinary command
// (tasks/w4/forms.md, Modals). What every client shares is here: the
// modal's content and key handling, as a pure function of
// (state, key) → state. How it is drawn is each client's business.
//
// A modal is optional form fields on top (a search box) and a list
// below them, which scrolls. Up and down move through the list, Enter
// ends the modal, Escape dismisses it, and every other key edits the
// fields. Whoever opened the modal refilters `items` when the fields
// change.

import { forms, type Answers, type Form, type FormState, type Key } from './forms.ts'

// What each list row of a tree modal is: a model `id`, or a category
// `path` ("anthropic/opus") with the model Enter picks for it. `parent` is
// the category the row is in. `open` holds the categories shown open
// while the search box is empty; while searching a category shows open
// by itself (common/picker.ts rows) unless in `closed`, or if in
// `opened`. A category row's `open` says how it is shown now. `current`
// is the session's model.
export type TreeRow = { id?: string; path?: string; parent?: string; default?: string; open?: boolean }
export type Tree = { rows: TreeRow[]; open: string[]; closed?: string[]; opened?: string[]; current: string }

export type ModalState = {
	title: string
	/** Key hints for the outline, such as "enter: switch". */
	hint?: string
	form?: FormState
	items: string[]
	/** Words to highlight in the items (common/fuzzy.ts marks). */
	query?: string
	/** The model picker's tree (common/picker.ts); other modals omit it. */
	tree?: Tree
	selected: number
	/** The first list row in view; clients keep it with modals.scroll. */
	scroll: number
}

export type ModalAction = { type: 'submit'; answers: Answers; item?: number } | { type: 'cancel' }

function open(spec: { title: string; hint?: string; form?: Form; items?: string[] }): ModalState {
	let st: ModalState = { title: spec.title, items: spec.items ?? [], selected: 0, scroll: 0 }
	if (spec.hint) st.hint = spec.hint
	if (spec.form) st.form = forms.start('modal', spec.form)
	return st
}

function step(st: ModalState, key: Key): { state: ModalState; action?: ModalAction } {
	let plain = !key.ctrl && !key.alt && !key.cmd
	let submit = (state: ModalState): { state: ModalState; action: ModalAction } => {
		let action: ModalAction = { type: 'submit', answers: state.form ? forms.answers(state.form) : {} }
		if (state.items.length) action.item = state.selected
		return { state, action }
	}
	if (key.key === 'escape') return { state: st, action: { type: 'cancel' } }
	if (key.key === 'enter' && plain) return submit(st)
	let move = key.key === 'down' ? 1 : key.key === 'up' ? -1 : 0
	if (move && st.items.length) return { state: { ...st, selected: Math.max(0, Math.min(st.items.length - 1, st.selected + move)) } }
	if (!st.form) return { state: st }
	let r = forms.step(st.form, key)
	// New search text: the list starts again from its best match.
	let edited = r.state.values.some((v, i) => v !== st.form!.values[i])
	let state = edited ? { ...st, form: r.state, selected: 0, scroll: 0 } : { ...st, form: r.state }
	if (r.action?.type === 'submit') return submit(state)
	if (r.action?.type === 'cancel') return { state, action: r.action }
	return { state }
}

// The first row in view of a list of `count` rows, `visible` at a time,
// moved as little as possible from `scroll` to show `selected`.
function scroll(scroll: number, selected: number, count: number, visible: number): number {
	if (selected < scroll) scroll = selected
	else if (selected >= scroll + visible) scroll = selected - visible + 1
	return Math.max(0, Math.min(scroll, count - visible))
}

export const modals = { open, step, scroll }
