// Runs find requests for one client: it waits for typing to pause before
// it searches, and cancels the previous search. No timers run until find
// opens.
import { findDialog } from './find-dialog.ts'
import type { FindBatch, FindFilter } from './find.ts'
import type { ModalState } from './modals.ts'

type Hooks = { get(): ModalState | undefined; set(m: ModalState): void; send(c: unknown): void; id(): string }
export type FindController = { filters: FindFilter[]; timer?: ReturnType<typeof setTimeout> }
function create(): FindController {
	return { filters: [...findDialog.filters] }
}
function close(st: FindController, h: Hooks): void {
	if (st.timer) clearTimeout(st.timer)
	delete st.timer
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
export const findController = { create, close, command, update, more, event }
