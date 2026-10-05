// The /config modal (task c0h): a row per setting of common/settings.ts,
// its label and value in two columns. The selected row also shows,
// faint, what config.ason holds for it (`push: false`, or the name and
// "(default)"), and its description below the list. Typing filters by
// name and label. Enter or Space cycles a boolean or choice, or edits a
// value in place: Enter saves, Escape restores. Every change is sent at
// once as /config <name> <value> and the modal stays open; the host's
// `settings` refresh then shows the result. Shared by terminal and web.

import { forms, type Key } from './forms.ts'
import { modals, type ModalAction, type ModalState } from './modals.ts'
import { picker } from './picker.ts'
import { settings, type Setting } from './settings.ts'

type Data = { values: Record<string, string>; stored: Record<string, string> }
type Step = { state: ModalState; action?: ModalAction }

const HINT = 'type: search · enter/space: change · esc: close'
const EDIT_HINT = 'enter: save · esc: restore'

function find(name: string | undefined): Setting | undefined {
	return settings.table.find((s) => s.name === name)
}

// A value as the list shows it: booleans on/off, a secret only whether
// it is set.
function shown(s: Setting, text: string): string {
	if (s.type.kind === 'boolean') return text === 'true' ? 'on' : 'off'
	if (s.type.kind === 'secret') return text ? 'set' : 'not set'
	return text === '' ? '(empty)' : text
}

// `st`'s rows for its search and data, keeping `keep` (a name) selected
// if it is still listed.
function refilter(st: ModalState, keep?: string): ModalState {
	let data = st.settings!
	let labels = Object.fromEntries(settings.table.map((s) => [s.name, s.label]))
	let query = st.form?.values[0] ?? ''
	let names = picker.rank(settings.table.map((s) => s.name), query, labels)
	let rows = names.map((n) => find(n)!)
	let selected = keep && names.includes(keep) ? names.indexOf(keep) : Math.min(st.selected, Math.max(0, names.length - 1))
	let next: ModalState = {
		...st,
		items: rows.map((s) => s.label),
		values: rows.map((s) => shown(s, data.values[s.name] ?? '')),
		notes: rows.map((s) => data.stored[s.name] ?? `${s.name} (default)`),
		details: rows.map((s) => s.description),
		settings: { ...data, names },
		selected,
	}
	if (query.trim()) next.query = query
	else delete next.query
	return next
}

function open(data: Data): ModalState {
	let st = modals.open({ title: 'Settings', hint: HINT, form: { text: 'Settings', fields: [{ type: 'text', name: 'search', label: 'Search' }] } })
	return refilter({ ...st, settings: { ...data, names: [] } })
}

// Newer data from the host: the open modal keeps its search, selection
// and any edit in progress.
function refresh(st: ModalState, data: Data): ModalState {
	let names = st.settings!.names
	let editing = st.edit && names[st.edit.index]
	let next = refilter({ ...st, settings: { ...data, names } }, names[st.selected])
	if (!editing) return next
	let index = next.settings!.names.indexOf(editing)
	return index < 0 ? { ...without(next), hint: HINT } : { ...next, edit: { ...st.edit!, index } }
}

function without(st: ModalState): ModalState {
	let { edit: _e, error: _r, ...rest } = st
	return rest
}

function send(sessionId: string, s: Setting, text: string): ModalAction {
	return { type: 'send', command: { type: 'submit', sessionId, text: `/config ${s.name} ${text === '' ? '""' : text}` } }
}

function step(st: ModalState, key: Key, sessionId: string): Step {
	let names = st.settings!.names
	let plain = !key.ctrl && !key.alt && !key.cmd
	if (st.edit) {
		let s = find(names[st.edit.index])!
		if (key.key === 'escape') return { state: { ...without(st), hint: HINT } }
		if (key.key === 'enter' && plain) {
			let text = st.edit.form.values[0]!
			let why = settings.problem(s.type, settings.fromText(s.type, text))
			if (why) return { state: { ...st, error: `${s.name}: ${why}` } }
			return { state: { ...without(st), hint: HINT }, action: send(sessionId, s, text) }
		}
		let { error: _r, ...rest } = st
		return { state: { ...rest, edit: { ...st.edit, form: forms.step(st.edit.form, key).state } } }
	}
	let s = find(names[st.selected])
	if (s && plain && (key.key === 'enter' || key.text === ' ')) {
		let now = st.settings!.values[s.name] ?? ''
		if (s.type.kind === 'boolean') return { state: st, action: send(sessionId, s, now === 'true' ? 'false' : 'true') }
		if (s.type.kind === 'choice') {
			let options = s.type.options
			return { state: st, action: send(sessionId, s, options[(options.indexOf(now) + 1) % options.length]!) }
		}
		let field = s.type.kind === 'secret' ? { type: 'secret' as const, name: s.name, label: s.label } : { type: 'text' as const, name: s.name, label: s.label, initial: now }
		return { state: { ...st, edit: { index: st.selected, form: forms.start('setting', { text: s.label, fields: [field] }) }, hint: EDIT_HINT } }
	}
	let r = modals.step(st, key)
	if (r.action?.type === 'cancel') return r
	return { state: r.state.form?.values[0] !== st.form?.values[0] ? refilter(r.state) : r.state }
}

// The search box now says `text` (typed natively on the web).
function search(st: ModalState, text: string): ModalState {
	return refilter({ ...st, form: forms.set(st.form!, 0, text), selected: 0, scroll: 0 })
}

// The edit field now says `text` (typed natively on the web).
function edited(st: ModalState, text: string): ModalState {
	if (!st.edit) return st
	let { error: _r, ...rest } = st
	return { ...rest, edit: { ...st.edit, form: forms.set(st.edit.form, 0, text) } }
}

export const settingsModal = { open, refresh, step, search, edited, shown }
