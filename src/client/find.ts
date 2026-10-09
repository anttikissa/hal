// Terminal adapter for the shared find modal and block navigation.
import { backfill } from '../common/backfill.ts'
import { connection } from '../common/connection.ts'
import { findController } from '../common/find-controller.ts'
import { findDialog } from '../common/find-dialog.ts'
import type { FindBatch, FindResult } from '../common/find.ts'
import { app } from './app.ts'
import { folds } from './folds.ts'

const hooks = {
	get: () => app.state.modal,
	set: (m: NonNullable<typeof app.state.modal>) => { app.state.modal = m; app.show() },
	send: (c: unknown) => app.send(c), id: () => connection.nextId(),
}
function open(): void {
	app.close()
	app.open(findDialog.open(find.state.filters), (a, m) => {
		let r = m.find!.results[a.item ?? 0]
		if (r) find.go(r)
	}, (m, k) => {
		let r = findDialog.step(m, k)
		if (r.state.form?.values[0] !== m.form?.values[0] || r.state.find!.filters !== m.find!.filters) findController.update(find.state, hooks, r.state)
		return r
	})
}
function go(r: FindResult): void {
	find.aim(r)
	if (app.state.tabs.some((t) => t.id === r.sessionId)) app.focusOn({ tab: r.sessionId })
	else app.send({ type: 'tab-resume', sessionId: r.sessionId })
	find.seek()
}
// Targets block `r` and opens it, as the web opens a linked card.
function aim(r: NonNullable<typeof find.target>): void {
	find.target = r
	let states = folds.of(r.sessionId)
	if (states.get(r.blockId) !== 'inline') states.set(r.blockId, 'open')
}
function seek(): void {
	let r = find.target, t = app.state.transcript
	if (!r || t?.meta.id !== r.sessionId || !r.blockId) return
	if (t.items.some((i) => i.key === r.blockId)) return
	let c = backfill.next(app.state.older, r.sessionId)
	if (c) setTimeout(app.send, 0, c)
}
export const find = {
	state: findController.create(), target: undefined as (Pick<FindResult, 'sessionId' | 'blockId'> & Partial<FindResult>) | undefined,
	open, go, aim, seek,
	close: (): void => findController.close(find.state, hooks),
	event: (b: FindBatch): void => findController.event(hooks, b),
}
