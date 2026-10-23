// Connects the shared find modal and block navigation to the terminal.
import { backfill } from '../common/backfill.ts'
import { titles } from '../common/titles.ts'
import { connection } from '../common/connection.ts'
import { findController } from '../common/find-controller.ts'
import { findDialog } from '../common/find-dialog.ts'
import type { FindBatch, FindPreview } from '../common/find.ts'
import { app } from './app.ts'
import { appView } from './app-view.ts'
import { frame } from './frame.ts'
import { tabs } from './tabs.ts'

const hooks = {
	get: () => app.state.modal,
	set: (m: NonNullable<typeof app.state.modal>) => {
		app.state.modal = m
		app.show()
		findController.preview(find.state, hooks)
	},
	send: (c: unknown) => app.send(c),
	id: () => connection.nextId(),
}
function open(): void {
	app.close()
	app.open(
		findDialog.open(
			find.state.filters,
			app.state.tabs.map((t) => t.id),
			app.state.transcript?.meta.id,
		),
		(a, m) => {
			let r = m.find!.results[a.item ?? 0]
			if (r) find.go(r)
		},
		(m, k) => {
			let r = findDialog.step(m, k)
			if (r.state.form?.values[0] !== m.form?.values[0] || r.state.find!.filters !== m.find!.filters)
				findController.update(find.state, hooks, r.state)
			// After the caller shows `r`.
			else
				queueMicrotask(() => {
					if (!app.state.modal?.find) return
					findController.preview(find.state, hooks)
					findController.more(hooks, findDialog.near(app.state.modal))
				})
			return r
		},
	)
	// An empty query lists the recently updated tabs.
	findController.update(find.state, hooks, app.state.modal!)
}
function go(r: NonNullable<typeof find.target>): void {
	find.target = r
	let ids = app.state.tabs.map((t) => t.id)
	if (ids.includes(r.sessionId)) app.focusOn(tabs.focus(ids, ids, app.state.focus, r.sessionId))
	else app.send({ type: 'tab-resume', sessionId: r.sessionId })
	find.report()
}
function report(): void {
	let r = find.target
	if (!r?.blockId || app.state.transcript?.meta.id !== r.sessionId || !backfill.complete(app.state.older, r.sessionId))
		return
	find.target = undefined
	let f = frame.build(appView.view(), app.cols(), 24, true),
		at = f.items!.findIndex((i) => i.key === r.blockId)
	app.state.notice = `Hal can't scroll the terminal, but ${r.sessionId}/${f.items![at] ? titles.blockId(f.items![at]!) : r.blockId} is about ${Math.round((100 * (f.ends![at - 1] ?? 0)) / f.lines.length)}% down the scrollback.`
}
export const find = {
	state: findController.create(),
	target: undefined as { sessionId: string; blockId?: string } | undefined,
	open,
	go,
	report,
	close: (): void => findController.close(find.state, hooks),
	event: (b: FindBatch): void => findController.event(hooks, b),
	previewed: (p: FindPreview): void => findController.previewed(find.state, hooks, p),
}
