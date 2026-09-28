// /close: closes the tab shown.

import { app } from '../app.ts'

export const command = {
	run(): void {
		let tab = app.focusedTab()
		if (tab) app.send({ type: 'tab-close', sessionId: tab.id })
	},
}
