// /new: a new tab after this one, in its cwd; focus moves to it once
// the host names it (tasks/7w).

import { app } from '../app.ts'

export const command = {
	run(): void {
		let tab = app.focusedTab()
		if (tab) app.send({ type: 'tab-new', cwd: tab.cwd, after: tab.id })
	},
}
