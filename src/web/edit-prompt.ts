// The Edit button on a prompt card (task 26q): the prompt's text goes
// into the box, and Enter sends it in that prompt's place: the newest
// as the usual edit of the last prompt (src/common/amend.ts), an
// earlier one rewinding the conversation there (the host drops it and
// everything after it in one rebase). Meanwhile the draft is set aside:
// the box shows the edit without changing the draft, which comes back
// on cancel (Escape, the bar's Cancel, or Enter on an emptied box) and
// after sending. A working session is paused when the edit begins and
// continued on cancel.
// Tasks: rqq.

import { queueEdit } from '../common/queue-edit.ts'
import { queuedPrompt } from './queue-edit.ts'
import { amend, type Editing } from '../common/amend.ts'
import { connection } from '../common/connection.ts'
import { drafts } from '../common/drafts.ts'
import { recall } from '../common/recall.ts'
import { app } from './app.ts'
import type { ViewState } from './view.ts'

// Beginning to edit prompt `key`: the view after, the pause to send and
// the box's text. Moving from one edit to another keeps the pause the
// first one made.
function begin(st: ViewState, key: string): { view: ViewState; command?: unknown; text: string } | undefined {
	let begun = st.transcript && amend.at(st.transcript, key)
	if (!begun) return undefined
	let editing = { ...begun.editing }
	if (!begun.command && st.editing && st.editing.paused !== false) editing.paused = true
	let text = amend.text(editing)
	amend.syncActive(editing, text)
	let out: { view: ViewState; command?: unknown; text: string } = { view: { ...st, editing }, text }
	if (begun.command) out.command = begun.command
	return out
}

// Leaving an edit begun here: the view after and the continue to send,
// if beginning paused the turn.
function cancel(st: ViewState): { view: ViewState; command?: unknown } | undefined {
	let editing = st.editing
	if (!editing?.aside) return undefined
	let command = amend.resume(editing, st.transcript)
	let notice = st.notice === amend.unsavedNotice ? undefined : st.notice
	return command
		? { view: { ...st, editing: undefined, notice }, command }
		: { view: { ...st, editing: undefined, notice } }
}

// What the box shows when no edit sets the draft aside.
function draft(id: string | undefined): string {
	return id === undefined ? '' : (recall.shown(id) ?? drafts.text(id))
}

function edit(key: string): boolean {
	let t = app.state.view.transcript
	let waiting = t?.inbox.find((m) => m.delivery === 'after-turn' && m.id === key)
	if (waiting) return queuedPrompt.begin(waiting.id)
	if (app.state.view.editing?.queueEdit || (t && queueEdit.current(t.meta.id)?.active)) return false
	if (app.state.view.editing) amend.typed(app.state.view.editing, app.state.text)
	let out = editPrompt.begin(app.state.view, key)
	if (!out) return false
	app.state.view = out.view
	if (out.command) connection.send(out.command)
	app.rewrite(() => ({ text: out.text, cursor: out.text.length }), true)
	return true
}

function leave(): boolean {
	let editing = app.state.view.editing
	if (editing?.queueEdit) return queuedPrompt.cancel()
	let out = editPrompt.cancel(app.state.view)
	if (!out || !editing) return false
	let changed = app.state.text !== editing.original
	amend.typed(editing, app.state.text)
	drafts.clearAmend(editing.sessionId)
	app.state.view = changed ? { ...out.view, notice: amend.canceledNotice } : out.view
	if (out.command) connection.send(out.command)
	let next = editPrompt.draft(app.sessionId())
	app.rewrite(() => ({ text: next, cursor: next.length }), true)
	return true
}

function input(id: string, text: string): void {
	if (queueEdit.input(id, text)) return
	let editing = app.state.view.editing
	if (editing) amend.typed(editing, text)
	else if (recall.typed(id, text)) drafts.edit(id, text)
}

function restore(): void {
	let st = app.state
	let t = st.view.transcript
	if (!t || st.view.editing || queueEdit.editing(t.meta.id)) return
	let restored = amend.restore(t)
	if (!restored) return
	st.view = { ...st.view, editing: restored.editing }
	st.text = restored.text
}

function finish(editing: Editing | undefined, text: string): void {
	if (editing) amend.finish(editing, text)
}

export const editPrompt = { begin, cancel, draft, edit, leave, input, restore, finish }
