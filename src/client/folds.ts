// Which transcript blocks this terminal shows expanded or collapsed
// (tasks ghs, v8y): /toggle, /expand and /collapse typed here and
// Ctrl-O change them locally, unrecorded; a toggle event (the model's
// command) changes them too. In memory only, per session: not stored,
// not synced to other clients. Pastes shown inline are fetched from
// the host once and kept.

import { blocksDialog } from '../common/blocks-dialog.ts'
import { modals } from '../common/modals.ts'
import type { Event } from '../common/protocol.ts'
import { toggle, type Fold, type Mode } from '../common/toggle.ts'
import type { Item, Transcript } from '../common/transcript.ts'
import { app } from './app.ts'

// Session → block key → state; paste name → its text, or why none.
const state = { folds: new Map<string, Map<string, Fold>>(), pastes: new Map<string, { text?: string; error?: string }>() }

// The states of session `id`'s blocks.
function of(id: string): Map<string, Fold> {
	let m = state.folds.get(id)
	if (!m) state.folds.set(id, (m = new Map()))
	return m
}

// Block `item`'s state in session `id`.
function fold(id: string, item: Item): Fold {
	return folds.of(id).get(item.key) ?? toggle.initial(item)
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
	let done = toggle.apply(mode, states, t.items, args)
	if (typeof done === 'string') return done
	// Pastes opened inline: their text comes from the host.
	for (let key of done) {
		if (states.get(key) !== 'inline') continue
		for (let name of toggle.pastes(t.items.find((i) => i.key === key)!)) {
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
	let m = /^\/(toggle|expand|collapse)(?:\s+(.*))?$/s.exec(text.trim())
	let id = app.state.transcript?.meta.id
	if (!m || id === undefined) return false
	let error = folds.run(id, m[2] ?? '', m[1] as Mode)
	if (error) app.state.notice = error
	app.show()
	return true
}

// Ctrl-O: asks which blocks to expand or collapse.
function open(): void {
	let t = app.state.transcript
	if (!t) return
	let id = t.meta.id
	let at = (i: Item) => folds.fold(id, i)
	app.close()
	app.open(blocksDialog.update(blocksDialog.open(), t.items, at), (action) => {
		let error = folds.run(id, action.answers.target ?? '')
		if (error) app.state.notice = error
		return undefined
	}, (m, k) => {
		let items = folds.transcriptOf(id)?.items ?? []
		if (k.key === 'tab' && !k.shift && !k.ctrl && !k.alt) return { state: blocksDialog.complete(m, items, at) }
		let r = modals.step(m, k)
		return r.state.form!.values[0] !== m.form!.values[0] ? { ...r, state: blocksDialog.update(r.state, items, at) } : r
	})
}

// The model's command, or a paste's text arriving.
function event(e: Event & { type: 'toggle' | 'paste-text' }): void {
	if (e.type === 'toggle') return void folds.run(e.sessionId, e.target, e.mode)
	folds.state.pastes.set(e.name, e.text === undefined ? { error: e.error ?? 'no text' } : { text: e.text })
	app.show()
}

export const folds = { state, of, fold, transcriptOf, run, typed, open, event }
