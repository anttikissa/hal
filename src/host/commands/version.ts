// /version: the code the host process runs, for bug reports (task n1).

import type { SlashCommand } from '../commands.ts'
import { version } from '../version.ts'

export const command: SlashCommand = {
	help: () => "/version shows the host's startup commit, plus a short hash of the uncommitted diff when there was one, and whether a newer commit is checked out.",
	run: () => {
		let st = version.state
		if (!st.loaded) return { say: 'version: still looking it up' }
		return { say: `version ${st.loaded}${st.newCode ? '; a newer commit is checked out (ctrl-r loads it)' : ''}` }
	},
}
