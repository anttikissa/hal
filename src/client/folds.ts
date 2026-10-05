// Which transcript blocks this terminal shows open or closed (task
// ghs): /toggle typed here and Ctrl-O flip them locally, unrecorded; a
// toggle event (the model's /toggle) flips them too. In memory only,
// per session: not stored, not synced to other clients. Pastes shown
// inline are fetched from the host once and kept.

import { modals, type ModalState } from '../common/modals.ts'
import type { Event } from '../common/protocol.ts'
import { toggle, type Fold } from '../common/toggle.ts'
import type { Transcript } from '../common/transcript.ts'
import { app } from './app.ts'

// Session → block key → state; paste name → its text, or why none.
const state = { folds: new Map<string, Map<string, Fold>>(), pastes: new Map<string, { text?: string; error?: string }>() }

// The states of session `id`'s blocks.
function of(id: string): Map<string, Fold> {
	let m = state.folds.get(id)
	if (!m) state.folds.set(id, (m = new Map()))
	return m
}

// The transcript of session `id`, shown or kept for a hidden tab.
function transcriptOf(id: string): Transcript | undefined {
	let st = app.state
	return st.transcript?.meta.id === id ? st.transcript : st.hidden.get(id)?.transcript
}

// Flips the blocks `args` names in session `id`. Returns why nothing
// was flipped, or undefined.
function run(id: string, args: string): string | undefined {
	let target = toggle.parse(args)
	if (typeof target === 'string') return target
	let t = transcriptOf(id)
	if (!t) return undefined
	let states = folds.of(id)
	let done = toggle.flip(states, t.items, target)
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

// Typed /toggle: true if `text` was one (and it ran).
function typed(text: string): boolean {
	let m = /^\/toggle(?:\s+(.*))?$/s.exec(text.trim())
	let id = app.state.transcript?.meta.id
	if (!m || id === undefined) return false
	let error = folds.run(id, m[1] ?? '')
	if (error) app.state.notice = error
	app.show()
	return true
}

const examples = ['10-24   (toggle blocks 10-24)', '25   (you can also close an assistant message)', '#t24   (one tool call)', '(empty: the latest tool block)']

// Ctrl-O: asks which blocks to toggle.
function open(): void {
	let id = app.state.transcript?.meta.id
	if (id === undefined) return
	app.close()
	let modal: ModalState = { compact: true, ...modals.open({ title: 'Toggle', hint: 'enter: toggle · esc: close', form: { text: 'Toggle', fields: [{ type: 'text', name: 'target', placeholder: examples }] } }) }
	app.open(modal, (action) => {
		let error = folds.run(id, action.answers.target ?? '')
		if (error) app.state.notice = error
		return undefined
	})
}

// The model's /toggle, or a paste's text arriving.
function event(e: Event & { type: 'toggle' | 'paste-text' }): void {
	if (e.type === 'toggle') return void folds.run(e.sessionId, e.target)
	folds.state.pastes.set(e.name, e.text === undefined ? { error: e.error ?? 'no text' } : { text: e.text })
	app.show()
}

export const folds = { state, of, run, typed, open, event }
