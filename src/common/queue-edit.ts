// Protected editing of queued prompts (task jsg), shared by both clients.
// Only the host's acquisition reply opens the editor. Edits live beside,
// not inside, the shared draft, so reloads and acknowledgements lose neither.
import { connection } from './connection.ts'
import { drafts } from './drafts.ts'
import type { Editing } from './amend.ts'
import type { Event } from './protocol.ts'
import type { InboxItem } from './inbox.ts'
import type { Transcript } from './transcript.ts'

export type QueueEditing = { edit: string; message: string; text: string; original?: string; active: boolean; request?: string; saving?: string }

function candidate(t: Transcript | undefined): InboxItem | undefined {
	return t?.inbox.findLast((m) => m.queue && m.from === undefined && m.origin !== 'model')
}

function current(id: string): QueueEditing | undefined { return drafts.local(id).queueEdit }
function ready(id: string): boolean {
	let e = queueEdit.current(id)
	return !!e?.active && !e.saving && queueEdit.state.ready.has(e.edit) && connection.connected()
}
function editing(id: string): Editing | undefined {
	let e = queueEdit.current(id)
	return e?.active && e.original !== undefined ? { sessionId: id, original: e.original, inbox: e.message, queueEdit: e.edit, aside: true } : undefined
}
function text(id: string): string {
	let e = queueEdit.current(id)
	return e?.active && e.original !== undefined ? e.text : drafts.text(id)
}
function notice(id: string): string | undefined {
	let e = queueEdit.current(id)
	if (!e?.active) return undefined
	if (e.saving) return 'Saving queued message…'
	if (e.original === undefined) return 'Pausing to edit queued message…'
	if (!queueEdit.ready(id)) return 'Queued edit kept; reconnecting to protect the message before saving…'
}
function acquire(id: string): void {
	let e = queueEdit.current(id)!
	e.request = connection.nextId()
	drafts.save(id)
	connection.send({ type: 'queue-edit', sessionId: id, message: e.message, edit: e.edit, id: e.request })
}
function recover(id: string): void {
	let e = queueEdit.current(id)
	if (!e) return
	queueEdit.state.ready.delete(e.edit)
	delete drafts.local(id).queueEdit
	if (e.original !== undefined && e.text !== e.original && e.text) {
		let draft = drafts.text(id)
		drafts.edit(id, draft ? `${draft}\n\n${e.text}` : e.text)
	}
	drafts.save(id)
}
function begin(t: Transcript, message: string): boolean {
	let id = t.meta.id
	let waiting = t.inbox.find((m) => m.id === message && m.queue && m.from === undefined && m.origin !== 'model')
	if (!waiting) return false
	let previous = queueEdit.current(id)
	if (previous?.active) return true
	if (previous && previous.message !== message) queueEdit.recover(id)
	let kept = queueEdit.current(id)
	drafts.local(id).queueEdit = { edit: connection.nextId(), message, text: kept?.text ?? '', original: kept?.original, active: true }
	queueEdit.acquire(id)
	return true
}
function input(id: string, text: string): boolean {
	let e = queueEdit.current(id)
	if (!e?.active || e.original === undefined) return false
	e.text = text
	drafts.save(id)
	return true
}
function cancel(id: string): string | undefined {
	let e = queueEdit.current(id)
	if (!e?.active) return undefined
	if (e.saving) return 'Wait for the queued edit to finish saving.'
	e.active = false
	queueEdit.state.ready.delete(e.edit)
	let changed = e.original !== undefined && e.text !== e.original
	if (!changed) delete drafts.local(id).queueEdit
	drafts.save(id)
	connection.send({ type: 'queue-edit-cancel', sessionId: id, edit: e.edit })
	return changed ? 'Queue edit cancelled; unsaved changes are kept. Edit this queued message again to recover them.' : undefined
}
function save(id: string): string | undefined {
	let e = queueEdit.current(id)
	if (!queueEdit.ready(id) || !e) return 'The queued message is not protected yet; wait for the host before saving.'
	if (!e.text.trim()) return queueEdit.cancel(id)
	// Never clear the original draft or show a second optimistic queue row.
	e.saving = connection.nextId()
	drafts.save(id)
	drafts.submit(id, e.text, { id: e.saving, amend: true, edits: e.message, queueEdit: e.edit })
}
function onEvent(event: Event): { sessionId: string; notice?: string } | undefined {
	if (event.type === 'ack' || event.type === 'rejected') {
		for (let [id, local] of drafts.state.sessions) {
			let e = local.queueEdit
			if (!e) continue
			if (event.id === e.saving) {
				if (event.type === 'ack') { queueEdit.state.ready.delete(e.edit); delete local.queueEdit; drafts.save(id) }
				else { delete e.saving; queueEdit.recover(id) }
				return { sessionId: id }
			}
			if (event.type === 'rejected' && event.id === e.request) {
				queueEdit.recover(id)
				return { sessionId: id }
			}
		}
	}
	if (!('sessionId' in event) || !event.sessionId) return undefined
	let id = event.sessionId
	let e = event.type === 'snapshot' ? queueEdit.current(id) : drafts.state.sessions.get(id)?.queueEdit
	if (!e) return undefined
	if (event.type === 'queue-hold' && event.message === undefined) queueEdit.state.ready.delete(e.edit)
	if (event.type === 'queue-edit' && e.active && e.edit === event.edit && e.message === event.message) {
		if (e.original !== undefined && event.text !== e.original && !e.saving) {
			queueEdit.cancel(id); queueEdit.recover(id)
			return { sessionId: id, notice: 'The queued message changed while disconnected; your unsaved edit was restored to the draft rather than overwriting it.' }
		}
		if (e.original === undefined) { e.original = event.text; e.text = event.text }
		delete e.request
		queueEdit.state.ready.add(e.edit)
		drafts.save(id)
		return { sessionId: id }
	}
	if (event.type === 'snapshot' || event.type === 'inbox') {
		let waiting = event.type === 'snapshot' ? event.snapshot.inbox ?? [] : event.inbox
		if (!e.active && !waiting.some((m) => m.id === e.message)) {
			queueEdit.recover(id)
			return { sessionId: id, notice: 'Unsaved queue edit restored to the draft after its queued message left the inbox.' }
		}
		if (event.type === 'snapshot' && e.active) {
			queueEdit.state.ready.delete(e.edit)
			queueEdit.acquire(id)
		}
	}
}
function disconnected(): void { queueEdit.state.ready.clear() }
export const queueEdit = { state: { ready: new Set<string>() }, candidate, current, ready, editing, text, notice, acquire, recover, begin, input, cancel, save, onEvent, disconnected }
