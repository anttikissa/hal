// Which transcript blocks this terminal shows expanded or collapsed
// (tasks ghs, v8y, hyt): /toggle, /expand and /collapse typed here and
// Ctrl-O change them locally, unrecorded; a toggle event (the model's
// command) changes them too. In memory only, per session: not stored,
// not synced to other clients. Pastes shown inline are fetched from
// the host once and kept.

import { blocksDialog } from '../common/blocks-dialog.ts'
import { modals, type ModalState } from '../common/modals.ts'
import type { Event } from '../common/protocol.ts'
import { toggle, type Fold, type Mode } from '../common/toggle.ts'
import type { Item, Transcript } from '../common/transcript.ts'
import { app } from './app.ts'
import { draftPastes } from '../common/draft-pastes.ts'
import { drafts } from '../common/drafts.ts'
import { prompt } from '../common/prompt.ts'
import { promptUndo } from '../common/prompt-undo.ts'
import { queueEdit } from '../common/queue-edit.ts'
import { recall } from '../common/recall.ts'

let draft: ReturnType<typeof draftPastes.create> | undefined
let requested = false

function hinted(m: ModalState, items: Item[], at: (i: Item) => Fold) {
	let next = blocksDialog.update(m, items, at)
	if (m.form!.values[0]!.trim() !== 'p' || !draft) return next
	if (!requested) {
		requested = true
		for (let name of draft.names) app.send({ type: 'paste-text', sessionId: draft.sessionId, name })
	}
	return { ...next, blocks: { ...draft.hint(app.state.prompt.text), help: next.blocks!.help } }
}

// Session → block key → state; paste name → its text, or why none.
const state = { folds: new Map<string, Map<string, Fold>>(), canceled: new Map<string, Set<string>>(), pastes: new Map<string, { text?: string; error?: string }>() }

// The states of session `id`'s blocks.
function of(id: string): Map<string, Fold> {
	let m = state.folds.get(id)
	if (!m) state.folds.set(id, (m = new Map()))
	return m
}

// Session `id`'s block states: toggled ones, the rest as they start
// (toggle.starts). Make one per use: it scans the transcript.
function at(id: string): (item: Item) => Fold {
	let t = folds.transcriptOf(id)
	let start = t ? toggle.starts(t) : () => 'long' as Fold
	let states = folds.of(id)
	let canceled = state.canceled.get(id)
	if (!canceled) state.canceled.set(id, canceled = new Set())
	for (let item of t?.items ?? []) if (item.canceledReference && !canceled.has(item.key)) {
		canceled.add(item.key)
		states.set(item.key, 'short')
	}
	return (item) => states.get(item.key) ?? start(item)
}

// The transcript of session `id`, shown or kept for a hidden tab.
function transcriptOf(id: string): Transcript | undefined {
	let st = app.state
	return st.transcript?.meta.id === id ? st.transcript : st.hidden.get(id)?.transcript
}

// Applies `mode` with `args` in session `id`. Returns why nothing
// changed, or undefined.
function run(id: string, args: string, mode: Mode = 'toggle'): string | undefined {
	let t = folds.transcriptOf(id)
	if (!t) return undefined
	let states = folds.of(id)
	let items = toggle.items(t)
	let done = toggle.apply(mode, states, items, args, toggle.starts(t))
	if (typeof done === 'string') return done
	// Pastes opened inline: their text comes from the host.
	for (let key of done) {
		if (states.get(key) !== 'inline') continue
		for (let name of toggle.pastes(items.find((i) => i.key === key)!)) {
			if (folds.state.pastes.has(name)) continue
			folds.state.pastes.set(name, {})
			app.send({ type: 'paste-text', sessionId: id, name })
		}
	}
	app.show()
	return undefined
}

// Typed /toggle, /expand or /collapse: true if `text` was one (and it ran).
function typed(text: string): boolean {
	let m = /^\/(toggle|expand|collapse)(?:\s+(.*))?$/is.exec(text.trimEnd())
	let id = app.state.transcript?.meta.id
	if (!m || id === undefined) return false
	let error = folds.run(id, m[2] ?? '', m[1]!.toLowerCase() as Mode)
	if (error) app.state.notice = error
	app.show()
	return true
}

// Ctrl-O: asks which blocks to expand or collapse.
function open(): void {
	let t = app.state.transcript
	if (!t) return
	let id = t.meta.id
	let at = folds.at(id)
	app.close()
	draft = draftPastes.create(id, app.state.prompt.text)
	requested = false
	app.open(hinted(blocksDialog.open(), toggle.items(t), at), (action) => {
		if (action.answers.target?.trim() === 'p' && draft && app.state.transcript?.meta.id === id) {
			let expanded = draft.expand(app.state.prompt)
			if (typeof expanded === 'string') app.state.notice = expanded
			else {
				app.state.prompt = prompt.withoutTyped(promptUndo.record(expanded, app.state.prompt))
				if (!queueEdit.input(id, expanded.text) && recall.typed(id, expanded.text)) drafts.edit(id, expanded.text)
			}
			draft = undefined
			app.show()
			return undefined
		}
		draft = undefined
		let error = folds.run(id, action.answers.target ?? '')
		if (error) app.state.notice = error
		return undefined
	}, (m, k) => {
		let t = folds.transcriptOf(id)
		let items = t ? toggle.items(t) : []
		if (k.key === 'escape') draft = undefined
		if (k.key === 'enter' && m.form!.values[0]!.trim() === 'p') {
			let next = hinted(m, items, at)
			if (next.blocks!.invalid) return { state: next }
		}
		if (k.key === 'tab' && !k.shift && !k.ctrl && !k.alt) return { state: blocksDialog.complete(m, items, at) }
		let r = modals.step(m, k)
		return r.state.form!.values[0] !== m.form!.values[0] ? { ...r, state: hinted(r.state, items, at) } : r
	})
}

// The model's command, or a paste's text arriving.
function event(e: Event & { type: 'toggle' | 'paste-text' }): void {
	if (e.type === 'toggle') return void folds.run(e.sessionId, e.target, e.mode)
	let consumed = draft?.accept(e)
	if (consumed && app.state.modal?.blocks && app.state.transcript?.meta.id === draft!.sessionId) {
		let t = folds.transcriptOf(draft!.sessionId)
		if (t) app.state.modal = hinted(app.state.modal, toggle.items(t), folds.at(t.meta.id))
	}
	if (!consumed || folds.state.pastes.has(e.name)) folds.state.pastes.set(e.name, e.text === undefined ? { error: e.error ?? 'no text' } : { text: e.text })
	app.show()
}

export const folds = { state, of, at, transcriptOf, run, typed, open, event }
