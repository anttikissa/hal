// Protected editing of queued prompts (tasks jsg, zez), shared by both
// clients. Only the host's acquisition reply opens the editor. Edits live
// beside, not inside, the shared draft, so reloads and acknowledgements
// lose neither. One window edits at a time: `window` names the window
// that owns an edit (the store's, else this page load's or process's), so a store
// shared with other windows (localStorage, draft files) never makes them
// act on it; an edit left by a window that is gone is adopted.
import { connection } from './connection.ts'
import { drafts } from './drafts.ts'
import type { Editing } from './amend.ts'
import type { Event } from './protocol.ts'
import type { InboxItem } from './inbox.ts'
import type { Transcript } from './transcript.ts'

export type QueueEditing = { edit: string; message: string; text: string; original?: string; active: boolean; request?: string; saving?: string; window?: string }

function candidate(t: Transcript | undefined): InboxItem | undefined {
	return t?.inbox.findLast((m) => m.queue && m.from === undefined && m.origin !== 'model')
}

function mine(e?: QueueEditing): QueueEditing | undefined { return e && (e.window === undefined || e.window === queueEdit.windowId()) ? e : undefined }
function current(id: string): QueueEditing | undefined { return queueEdit.mine(drafts.local(id).queueEdit) }
// Another window holds the lock on one of the session's queued messages.
function elsewhere(t: Transcript): boolean {
	let e = queueEdit.current(t.meta.id)
	return !!t.queueHold && !(e?.active && e.message === t.queueHold)
}
// Delivery waits: the next queued message is the one being edited.
function waiting(t: Transcript): boolean {
	return !!t.queueHold && t.state.type === 'idle' && t.inbox.find((m) => m.queue)?.id === t.queueHold
}
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
function notice(t: Transcript): string | undefined {
	if (queueEdit.elsewhere(t)) return 'Editing queued message in another window'
	let e = queueEdit.current(t.meta.id)
	if (!e?.active) return undefined
	if (e.saving) return 'Saving queued message…'
	if (e.original === undefined) return 'Opening queued message…'
	if (!queueEdit.ready(t.meta.id)) return 'Reconnecting. Your edit is kept; you can save it when the connection is back.'
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
	// Another window edits: the notice says so; nothing to begin here.
	if (queueEdit.elsewhere(t)) return true
	queueEdit.adopt(id, t.queueHold)
	let previous = queueEdit.current(id)
	if (previous?.active) return true
	if (previous && previous.message !== message) queueEdit.recover(id)
	let kept = queueEdit.current(id)
	drafts.local(id).queueEdit = { edit: connection.nextId(), message, text: kept?.text ?? '', original: kept?.original, active: true, window: queueEdit.windowId() }
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
	if (e.saving) return 'Wait until the queued message is saved.'
	e.active = false
	queueEdit.state.ready.delete(e.edit)
	let changed = e.original !== undefined && e.text !== e.original
	if (!changed) delete drafts.local(id).queueEdit
	drafts.save(id)
	connection.send({ type: 'queue-edit-cancel', sessionId: id, edit: e.edit })
	return changed ? 'Edit canceled. Your changes are kept: edit this queued message again to get them back.' : undefined
}
function save(id: string): string | undefined {
	let e = queueEdit.current(id)
	if (!queueEdit.ready(id) || !e) return 'The queued message is not open for editing yet. Wait a moment, then save.'
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
	if (event.type === 'snapshot') queueEdit.adopt(id, event.snapshot.queueHold)
	let e = event.type === 'snapshot' ? queueEdit.current(id) : queueEdit.mine(drafts.state.sessions.get(id)?.queueEdit)
	if (!e) return undefined
	if (event.type === 'queue-hold' && event.message === undefined) queueEdit.state.ready.delete(e.edit)
	if (event.type === 'queue-edit' && e.active && e.edit === event.edit && e.message === event.message) {
		if (e.original !== undefined && event.text !== e.original && !e.saving) {
			queueEdit.cancel(id); queueEdit.recover(id)
			return { sessionId: id, notice: 'The queued message changed while you were disconnected. Your edit is in the draft; the message was not overwritten.' }
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
			return { sessionId: id, notice: 'The queued message was sent before you saved. Your unsaved edit is in the draft.' }
		}
		if (event.type === 'snapshot' && e.active) {
			queueEdit.state.ready.delete(e.edit)
			queueEdit.acquire(id)
		}
	}
}
// Takes over an edit another window left open and no longer holds (`hold`:
// the locked message), as canceled: its text waits for the next edit of
// the message, or goes to the draft if the message left. The store has
// the owner's latest copy; one it finished is gone from there.
function adopt(id: string, hold?: string): void {
	let local = drafts.local(id)
	if (!local.queueEdit || queueEdit.mine(local.queueEdit)) return
	let e = drafts.valid(drafts.store.load(id))?.queueEdit
	if (e) local.queueEdit = e
	else delete local.queueEdit
	if (!e || queueEdit.mine(e) || !e.active || e.message === hold) return
	e.window = queueEdit.windowId()
	e.active = false
	delete e.request; delete e.saving
	drafts.save(id)
}
function windowId(): string { return drafts.store.window?.() ?? queueEdit.state.window }
function disconnected(): void { queueEdit.state.ready.clear() }
export const queueEdit = { state: { ready: new Set<string>(), window: crypto.randomUUID() as string }, candidate, windowId, mine, current, elsewhere, waiting, ready, editing, text, notice, acquire, recover, adopt, begin, input, cancel, save, onEvent, disconnected }
