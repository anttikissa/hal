// Browser adapter: use the same modal, search box and stable block URLs.
import { connection } from '../common/connection.ts'
import { findController } from '../common/find-controller.ts'
import { findDialog } from '../common/find-dialog.ts'
import type { FindBatch } from '../common/find.ts'
import type { Key } from '../common/forms.ts'
import type { ModalState } from '../common/modals.ts'
import { app } from './app.ts'

const hooks = {
	get: () => app.state.view.modal,
	set: (modal: ModalState) => app.setView({ ...app.state.view, modal }),
	send: (c: unknown) => connection.send(c), id: () => connection.nextId(),
}
function open(): void {
	if (hooks.get()?.find) find.close()
	hooks.set(findDialog.open(find.state.filters))
}
function close(): void {
	app.setView({ ...app.state.view, modal: undefined })
}
function input(text: string): void {
	let m = hooks.get()
	if (m?.find) findController.update(find.state, hooks, findDialog.input(m, text))
}
function toggle(i: number): void {
	let m = hooks.get()
	if (m?.find) findController.update(find.state, hooks, findDialog.toggle(m, i))
}
function key(k: Key): void {
	let m = hooks.get()
	if (!m?.find) return
	let r = findDialog.step(m, k)
	if (r.action) {
		let hit = r.action.type === 'submit' && m.find.results[r.action.item ?? 0]
		find.close()
		if (hit) location.assign(hit.href)
	} else if (r.state.find!.filters !== m.find.filters) findController.update(find.state, hooks, r.state)
	else hooks.set(r.state)
}
function focus(index: number): void {
	let m = hooks.get()
	if (m?.find) hooks.set({ ...m, find: { ...m.find, focus: index } })
}
export const find = { state: findController.create(), open, close, input, toggle, key, focus, cancel: (): void => findController.close(find.state, hooks), event: (b: FindBatch): void => findController.event(hooks, b) }
