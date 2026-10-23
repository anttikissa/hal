// Runs find requests for one client: it waits for typing to pause before
// it searches, and cancels the previous search. No timers run until find
// opens.
import { findDialog } from './find-dialog.ts'
import type { FindBatch, FindFilter, FindPreview } from './find.ts'
import type { ModalState } from './modals.ts'

type Hooks = { get(): ModalState | undefined; set(m: ModalState): void; send(c: unknown): void; id(): string }
// `preview`: the key of the last preview asked for.
export type FindController = { filters: FindFilter[]; timer?: ReturnType<typeof setTimeout>; preview?: string }
function create(): FindController {
	return { filters: [...findDialog.filters] }
}
function close(st: FindController, h: Hooks): void {
	if (st.timer) clearTimeout(st.timer)
	delete st.timer
	delete st.preview
	h.send({ type: 'find-cancel' })
}
// The find command for `m`'s query, filters and row limit.
function command(m: ModalState): object {
	let f = m.find!
	return { type: 'find', request: f.request, query: m.form!.values[0]!, kinds: f.filters, here: f.here, limit: f.limit }
}
function update(st: FindController, h: Hooks, m: ModalState): void {
	st.filters = [...m.find!.filters]
	findController.close(st, h)
	h.set(m)
	st.timer = setTimeout(() => {
		delete st.timer
		m = h.get()!
		if (!m?.find) return
		m = { ...m, find: { ...m.find, request: h.id() } }
		h.set(m)
		h.send(findController.command(m))
	}, 80)
}
// Asks for the next page when `near` the end of a full result list.
function more(h: Hooks, near: boolean): void {
	let m = h.get()
	let next = m?.find && findDialog.more(m, near)
	if (!next) return
	h.set(next)
	h.send(findController.command(next))
}
function event(h: Hooks, b: FindBatch): void {
	let m = h.get()
	if (m?.find) h.set(findDialog.batch(m, b))
}
// The selected row's preview request with its query, keyed to drop stale
// replies (task w17).
function previewRequest(m: ModalState | undefined) {
	let r = m?.find?.results[m.selected]
	if (!r) return
	let c = { type: 'find-preview', sessionId: r.sessionId, blockId: r.blockId, kind: r.kind, query: m!.form!.values[0]! }
	return { c, key: JSON.stringify(c) }
}
// Asks for the selected row's preview when it changed.
function preview(st: FindController, h: Hooks): void {
	let p = findController.previewRequest(h.get())
	if (!p || p.key === st.preview) return
	st.preview = p.key
	h.send(p.c)
}
function previewed(st: FindController, h: Hooks, p: FindPreview): void {
	let m = h.get()
	let { type, sessionId, blockId, kind, query } = p
	if (m?.find && st.preview === JSON.stringify({ type, sessionId, blockId, kind, query }))
		h.set({ ...m, find: { ...m.find, preview: p } })
}
export const findController = { create, close, command, update, more, event, previewRequest, preview, previewed }
