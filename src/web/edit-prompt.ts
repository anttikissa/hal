// The Edit button on a prompt card (task 26q): the prompt's text goes
// into the box, and Enter sends it in that prompt's place: the newest
// as the usual edit of the last prompt (src/common/amend.ts), an
// earlier one rewinding the conversation there (the host drops it and
// everything after it in one rebase). Meanwhile the draft is set aside:
// the box shows the edit without changing the draft, which comes back
// on cancel (Escape, the bar's Cancel, or Enter on an emptied box) and
// after sending. A working session is paused when the edit begins and
// continued on cancel.

import { queueEdit } from '../common/queue-edit.ts'
import { queuedPrompt } from './queue-edit.ts'
import { amend } from '../common/amend.ts'
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
	let out: { view: ViewState; command?: unknown; text: string } = { view: { ...st, editing }, text: editing.original }
	if (begun.command) out.command = begun.command
	return out
}

// Leaving an edit begun here: the view after and the continue to send,
// if beginning paused the turn.
function cancel(st: ViewState): { view: ViewState; command?: unknown } | undefined {
	let editing = st.editing
	if (!editing?.aside) return undefined
	let command = amend.resume(editing, st.transcript)
	return command ? { view: { ...st, editing: undefined }, command } : { view: { ...st, editing: undefined } }
}

// What the box shows when no edit sets the draft aside.
function draft(id: string | undefined): string {
	return id === undefined ? '' : (recall.shown(id) ?? drafts.text(id))
}

function edit(key: string): boolean {
	let t = app.state.view.transcript
	let waiting = t?.inbox.find((m) => m.queue && m.id === key)
	if (waiting) return queuedPrompt.begin(waiting.id)
	if (app.state.view.editing?.queueEdit || (t && queueEdit.current(t.meta.id)?.active)) return false
	let out = editPrompt.begin(app.state.view, key)
	if (!out) return false
	app.state.view = out.view
	if (out.command) connection.send(out.command)
	app.input(out.text)
	return true
}

function leave(): boolean {
	if (app.state.view.editing?.queueEdit) return queuedPrompt.cancel()
	let out = editPrompt.cancel(app.state.view)
	if (!out) return false
	app.state.view = out.view
	if (out.command) connection.send(out.command)
	app.input(editPrompt.draft(app.sessionId()))
	return true
}

export const editPrompt = { begin, cancel, draft, edit, leave }
