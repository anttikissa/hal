// Terminal adapter for the shared find modal and block navigation.
import { backfill } from '../common/backfill.ts'
import { connection } from '../common/connection.ts'
import { findController } from '../common/find-controller.ts'
import { findDialog } from '../common/find-dialog.ts'
import type { FindBatch } from '../common/find.ts'
import { app } from './app.ts'
import { appView } from './app-view.ts'
import { frame } from './frame.ts'

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
function go(r: NonNullable<typeof find.target>): void {
	find.target = r
	if (app.state.tabs.some((t) => t.id === r.sessionId)) app.focusOn({ tab: r.sessionId })
	else app.send({ type: 'tab-resume', sessionId: r.sessionId })
	find.report()
}
function report(): void {
	let r = find.target
	if (!r?.blockId || app.state.transcript?.meta.id !== r.sessionId || !backfill.complete(app.state.older, r.sessionId)) return
	find.target = undefined
	let f = frame.build(appView.view(), app.cols(), 24, true), at = f.items!.findIndex((i) => i.key === r.blockId)
	app.state.notice = `Hal can't scroll the terminal, but #${r.blockId} is about ${Math.round((100 * (f.ends![at - 1] ?? 0)) / f.lines.length)}% down the scrollback`
}
export const find = {
	state: findController.create(), target: undefined as { sessionId: string; blockId?: string } | undefined,
	open, go, report,
	close: (): void => findController.close(find.state, hooks),
	event: (b: FindBatch): void => findController.event(hooks, b),
}
