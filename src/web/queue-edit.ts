// Connects the page to the shared editor for queued prompts (task jsg).
import { queueEdit } from '../common/queue-edit.ts'
import { drafts } from '../common/drafts.ts'
import { app } from './app.ts'

function begin(message: string): boolean {
	let st = app.state,
		t = st.view.transcript
	if (!t) return false
	if (st.view.form || st.view.modal) {
		app.setNotice('Finish the open question or dialog before editing a queued message.')
		return false
	}
	if (st.view.editing) {
		app.setNotice('Finish the current edit before editing a queued message.')
		return false
	}
	let begun = queueEdit.begin(t, message)
	if (begun) {
		queuedPrompt.sync()
		app.changed()
	}
	return begun
}
function sync(): void {
	let st = app.state,
		id = app.sessionId()
	if (!id) return
	let editing = queueEdit.editing(id)
	if (editing) {
		st.view = { ...st.view, editing }
		st.text = queueEdit.text(id)
	} else if (st.view.editing?.queueEdit) {
		st.view = { ...st.view, editing: undefined }
		st.text = drafts.text(id)
	}
}
// Ends an active queue edit by cancelling or saving it.
function end(how: 'cancel' | 'save'): boolean {
	let id = app.sessionId()
	if (!id || !queueEdit.current(id)?.active) return false
	let notice = queueEdit[how](id)
	queuedPrompt.sync()
	app.setNotice(notice)
	return true
}
export const queuedPrompt = { begin, sync, cancel: () => end('cancel'), save: () => end('save') }
