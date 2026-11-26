// Handles the terminal prompt's Up, Down and Escape before the editor
// does: editing the last prompt (common/amend.ts), then input history
// (common/recall.ts). Also handles the system clipboard's keys
// (clipboard.ts). Each handler takes the app's state and changes it in
// place; it returns true if it handled the key.

import { amend, type Editing } from '../common/amend.ts'
import { drafts } from '../common/drafts.ts'
import { prompt, type PromptState } from '../common/prompt.ts'
import { promptUndo } from '../common/prompt-undo.ts'
import { queueEdit } from '../common/queue-edit.ts'
import { queuedPrompt } from './queue-edit.ts'
import { clipboard } from './clipboard.ts'
import { recall } from '../common/recall.ts'
import { promptLayout } from '../common/prompt-layout.ts'
import type { Transcript } from '../common/transcript.ts'
import type { KeyEvent } from './keys.ts'

export type PromptKeysState = { transcript?: Transcript; prompt: PromptState; editing?: Editing; notice?: string }

const plain = (k: KeyEvent): boolean => !k.shift && !k.ctrl && !k.alt && !k.cmd

// Replaces the prompt text while recording the previous text on the undo stack.
function setText(st: PromptKeysState, text: string, cursor: number): void {
	let before = st.prompt
	let { goal: _, anchor: _a, typed: _t, ...rest } = before
	let next: PromptState = { ...rest, text, cursor }
	st.prompt = text === before.text ? next : promptUndo.record(next, before)
}

// Editing a prompt: Up on the top row starts or steps to an earlier prompt,
// Down on the bottom row steps forward or leaves (keeping unsent edits on
// the prompt and continuing a paused turn). Escape leaves when unchanged,
// or keeps the editor open with a notice when there are unsaved changes.
function edit(st: PromptKeysState, k: KeyEvent, send: (command: unknown) => void, width: number): boolean {
	let rows = promptLayout.rows(st.prompt.text, width)
	let { row } = promptLayout.position(st.prompt.text, rows, st.prompt.cursor)
	let top = k.key === 'up' && row === 0
	let bottom = k.key === 'down' && row === rows.length - 1
	if (queuedPrompt.key(st, k, top)) return true
	if (!plain(k) || !st.transcript) return false
	let id = st.transcript.meta.id
	if (top && !st.editing) {
		let begun = amend.begin(st.transcript)
		if (!begun) return false
		st.editing = begun.editing
		let text = amend.text(begun.editing)
		amend.syncActive(begun.editing, text)
		setText(st, text, text.length)
		if (begun.command) send(begun.command)
		return true
	}
	let editing = st.editing
	if (!editing || editing.queueEdit) return false
	if (k.key === 'escape') {
		if (st.prompt.text !== editing.original) {
			amend.typed(editing, st.prompt.text)
			st.notice = amend.unsavedNotice
			return true
		}
		drafts.clearAmend(id)
		st.editing = undefined
		let draft = recall.shown(id) ?? drafts.text(id)
		setText(st, draft, draft.length)
		let command = amend.resume(editing, st.transcript)
		if (command) send(command)
		return true
	}
	if (top || bottom) {
		amend.typed(editing, st.prompt.text)
		let dir: -1 | 1 = top ? -1 : 1
		let next = amend.step(editing, st.transcript, dir)
		if (next) {
			st.editing = next
			if (st.notice === amend.unsavedNotice) st.notice = undefined
			let text = amend.text(next)
			amend.syncActive(next, text)
			setText(st, text, dir < 0 ? text.length : recall.topEnd(text, width))
			return true
		}
		if (top) return true
		drafts.clearAmend(id)
		st.editing = undefined
		if (st.notice === amend.unsavedNotice) st.notice = undefined
		let draft = recall.shown(id) ?? drafts.text(id)
		setText(st, draft, recall.topEnd(draft, width))
		let command = amend.resume(editing, st.transcript)
		if (command) send(command)
		return true
	}
	return false
}

// Up on the top row or Down on the bottom one, at the prompt's content
// `width`: the previous or next prompt sent.
function history(st: PromptKeysState, k: KeyEvent, width: number): boolean {
	let t = st.transcript
	if (st.editing || !plain(k) || !t || (k.key !== 'up' && k.key !== 'down')) return false
	let id = t.meta.id
	let { text, cursor } = st.prompt
	let shown = recall.step(id, recall.items(t), text, cursor, k.key === 'up' ? -1 : 1, width, drafts.text(id))
	if (!shown) return false
	setText(st, shown.text, shown.cursor)
	return true
}

function typed(st: PromptKeysState, id: string, text: string): void {
	if (queueEdit.input(id, text)) return
	if (st.editing) amend.typed(st.editing, text)
	else if (recall.typed(id, text)) drafts.edit(id, text)
}

function restore(st: PromptKeysState, t: Transcript): void {
	if (st.editing || queueEdit.editing(t.meta.id)) return
	let restored = amend.restore(t)
	if (!restored) return
	st.editing = restored.editing
	let { anchor: _, typed: _t, ...rest } = st.prompt
	st.prompt = { ...rest, text: restored.text, cursor: restored.text.length }
}

// Cmd-C copies the selection and Cmd-X too, leaving the editor to
// remove it. Ctrl-V and Cmd-V read the clipboard and hand its text, or
// its image if it has no text, to `done` when it comes; the read never
// holds up the keys after it.
// Failures go to `done` as a notice. True if the editor needs the key
// no more.
export type Clip = { text: string } | { image: Uint8Array } | { notice: string }

function clip(st: PromptKeysState, k: KeyEvent, done: (r: Clip) => void): boolean {
	let only = (mod: 'ctrl' | 'cmd') => k[mod] && !k.shift && !k.alt && !k[mod === 'ctrl' ? 'cmd' : 'ctrl']
	if ((k.key === 'c' || k.key === 'x') && only('cmd')) {
		let sel = prompt.selection(st.prompt)
		if (sel) void clipboard.write(st.prompt.text.slice(sel.start, sel.end)).then((notice) => notice && done({ notice }))
		return k.key === 'c'
	}
	if (k.key !== 'v' || !(only('ctrl') || only('cmd'))) return false
	void clipboard
		.read()
		.then(async (r): Promise<Clip> => {
			let image = 'text' in r && r.text ? null : await clipboard.image()
			return image ? { image } : r
		})
		.then(done)
	return true
}

export const promptKeys = { edit, history, clip, typed, restore }
