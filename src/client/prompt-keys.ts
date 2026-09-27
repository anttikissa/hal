// The terminal prompt's Up, Down and Escape before the editor's own:
// editing the last prompt (common/amend.ts), then input history
// (common/recall.ts). Each takes the app's state and changes it in
// place; true if the key was handled.

import { amend, type Editing } from '../common/amend.ts'
import { drafts } from '../common/drafts.ts'
import { prompt, type PromptState } from '../common/prompt.ts'
import { recall } from '../common/recall.ts'
import type { Transcript } from '../common/transcript.ts'
import type { KeyEvent } from './keys.ts'

export type PromptKeysState = { transcript?: Transcript; prompt: PromptState; editing?: Editing }

const plain = (k: KeyEvent): boolean => !k.shift && !k.ctrl && !k.alt && !k.cmd

// Editing the last prompt: Up on an empty prompt while the session
// works starts it, Down unchanged or Escape leaves it. The editor text
// is the draft, as ever. `send` takes the pause or continue.
function edit(st: PromptKeysState, k: KeyEvent, send: (command: unknown) => void): boolean {
	if (!plain(k) || !st.transcript) return false
	let id = st.transcript.meta.id
	if (k.key === 'up' && !st.editing) {
		let begun = amend.begin(st.transcript, st.prompt.text)
		if (!begun) return false
		st.editing = begun.editing
		let { anchor: _, ...rest } = st.prompt
		st.prompt = { ...rest, text: begun.editing.original, cursor: begun.editing.original.length }
		drafts.edit(id, st.prompt.text)
		send(begun.command)
		return true
	}
	let editing = st.editing
	if (!editing || !(k.key === 'escape' || (k.key === 'down' && st.prompt.text === editing.original))) return false
	st.editing = undefined
	if (st.prompt.text === editing.original) {
		st.prompt = prompt.cleared(st.prompt)
		drafts.edit(id, '')
	}
	let command = amend.resume(editing, st.transcript)
	if (command) send(command)
	return true
}

// Up on the top row or Down on the bottom one, at the prompt's content
// `width`: the previous or next prompt sent.
function history(st: PromptKeysState, k: KeyEvent, width: number): boolean {
	let t = st.transcript
	if (!plain(k) || !t || (k.key !== 'up' && k.key !== 'down')) return false
	let id = t.meta.id
	let { text, cursor } = st.prompt
	let shown = recall.step(id, recall.entries(t), text, cursor, k.key === 'up' ? -1 : 1, width, drafts.text(id))
	if (!shown) return false
	let { goal: _, anchor: _a, typed: _t, ...rest } = st.prompt
	st.prompt = { ...rest, ...shown }
	return true
}

export const promptKeys = { edit, history }
