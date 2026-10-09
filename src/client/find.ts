// Terminal adapter for the shared find modal and block navigation.
import { backfill } from '../common/backfill.ts'
import { connection } from '../common/connection.ts'
import { findController } from '../common/find-controller.ts'
import { findDialog } from '../common/find-dialog.ts'
import type { FindBatch, FindResult } from '../common/find.ts'
import { titles } from '../common/titles.ts'
import { app } from './app.ts'
import { appView } from './app-view.ts'
import { frame } from './frame.ts'
import { render } from './render.ts'

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
// Goes to the block's tab. Hal can't scroll the terminal, so once the
// tab's history is all in, a notice says where the block is.
function go(r: NonNullable<typeof find.target>): void {
	find.target = r
	if (app.state.tabs.some((t) => t.id === r.sessionId)) app.focusOn({ tab: r.sessionId })
	else app.send({ type: 'tab-resume', sessionId: r.sessionId })
	find.report()
}
function report(): void {
	let r = find.target
	if (!r || app.state.transcript?.meta.id !== r.sessionId || !backfill.complete(app.state.older, r.sessionId)) return
	find.target = undefined
	if (!r.blockId) return
	let { rows, cols } = render.state.out?.size() ?? { rows: 24, cols: 80 }
	let f = frame.build(appView.view(), cols, rows, true)
	let at = f.items!.findIndex((i) => i.key === r.blockId)
	let row = at > 0 ? f.ends![at - 1]! : 0, top = f.lines.length - rows, label = at < 0 ? `#${r.blockId}` : `#${titles.blockId(f.items![at]!)}`
	app.state.notice = at < 0 ? `${label} is not in this session` : row >= top ? `${label} is on screen` : `Hal can't scroll the terminal: ${label} is about ${Math.round((100 * row) / top)}% down the scrollback`
}
export const find = {
	state: findController.create(), target: undefined as { sessionId: string; blockId?: string } | undefined,
	open, go, report,
	close: (): void => findController.close(find.state, hooks),
	event: (b: FindBatch): void => findController.event(hooks, b),
}
