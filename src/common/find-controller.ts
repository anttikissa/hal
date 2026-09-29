// A single client's debounce and cancellation; no timers until opened.
import { findDialog } from './find-dialog.ts'
import type { FindBatch, FindFilter } from './find.ts'
import type { ModalState } from './modals.ts'

type Hooks = { get(): ModalState | undefined; set(m: ModalState): void; send(c: unknown): void; id(): string }
export type FindController = { filters: FindFilter[]; timer?: ReturnType<typeof setTimeout> }
function create(): FindController { return { filters: [...findDialog.filters] } }
function close(st: FindController, h: Hooks): void {
	if (st.timer) clearTimeout(st.timer)
	delete st.timer
	h.send({ type: 'find-cancel' })
}
function update(st: FindController, h: Hooks, m: ModalState): void {
	st.filters = [...m.find!.filters]
	findController.close(st, h)
	h.set(m)
	st.timer = setTimeout(() => {
		delete st.timer
		m = h.get()!
		if (!m?.find) return
		let request = h.id()
		h.set({ ...m, find: { ...m.find!, request }, hint: 'searching…' })
		h.send({ type: 'find', request, query: m.form!.values[0]!, kinds: st.filters })
	}, 80)
}
function event(h: Hooks, b: FindBatch): void {
	let m = h.get()
	if (m?.find) h.set(findDialog.batch(m, b))
}
export const findController = { create, close, update, event }
