// Web adapter for the shared protected queue editor (task jsg).
import { queueEdit } from '../common/queue-edit.ts'
import { drafts } from '../common/drafts.ts'
import { app } from './app.ts'

function begin(message: string): boolean {
	let st = app.state, t = st.view.transcript
	if (!t) return false
	if (st.view.form || st.view.modal) { app.setNotice('Finish the open question or dialog before editing a queued message.'); return false }
	if (st.view.editing) { app.setNotice('Finish the current edit before editing a queued message.'); return false }
	let begun = queueEdit.begin(t, message)
	if (begun) { queuedPrompt.sync(); app.changed() }
	return begun
}
function sync(): void {
	let st = app.state, id = app.sessionId()
	if (!id) return
	let editing = queueEdit.editing(id)
	if (editing) { st.view = { ...st.view, editing }; st.text = queueEdit.text(id) }
	else if (st.view.editing?.queueEdit) { st.view = { ...st.view, editing: undefined }; st.text = drafts.text(id) }
}
function cancel(): boolean {
	let id = app.sessionId()
	if (!id || !queueEdit.current(id)?.active) return false
	let notice = queueEdit.cancel(id)
	queuedPrompt.sync()
	app.setNotice(notice)
	return true
}
function save(): boolean {
	let id = app.sessionId()
	if (!id || !queueEdit.current(id)?.active) return false
	let notice = queueEdit.save(id)
	queuedPrompt.sync()
	app.setNotice(notice)
	return true
}
export const queuedPrompt = { begin, sync, cancel, save }
