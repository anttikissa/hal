// /close: closes the tab shown.

import { app } from '../app.ts'
import { tabSwitch } from '../tab-switch.ts'

export const command = {
	run(): void {
		let tab = tabSwitch.focusedTab()
		if (tab) app.send({ type: 'tab-close', sessionId: tab.id })
	},
}
