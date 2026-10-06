// /version: the code the host process runs, for bug reports (task n1).

import type { SlashCommand } from '../commands.ts'
import { release } from '../release.ts'
import { version } from '../version.ts'

export const command: SlashCommand = {
	help: () => "/version shows the release and commit the host started from, plus a short hash of the uncommitted diff when there was one, and whether a newer commit is checked out.",
	run: async () => {
		let st = version.state
		if (!st.loaded) return { say: 'version: still looking it up' }
		return { say: `${await release.line(st.head, st.loaded.includes('+'))} (${st.loaded})${st.newCode ? '; a newer commit is checked out (/restart loads it)' : ''}` }
	},
}
