// /auth: a one-time code for logging a browser in (host/web-auth.ts),
// shown to this tab's clients but never recorded; /auth revoke logs
// every browser out.

import type { SlashCommand } from '../commands.ts'
import { webAuth } from '../web-auth.ts'
import { web } from '../web.ts'

export const command: SlashCommand = {
	help: () =>
		'/auth shows a one-time code for logging a browser in to the web client: good for 10 minutes and one login, and never saved in the transcript. `./run auth` in a shell prints one too. /auth revoke logs every browser out.',
	complete: (args) => ('revoke'.startsWith(args) ? ['revoke'] : []),
	run(args) {
		if (args === 'revoke') {
			web.revoke()
			return { say: 'every web session ended; a browser needs a new code' }
		}
		if (args) return { error: 'usage: /auth or /auth revoke' }
		let minutes = Math.round(webAuth.codeMs / 60_000)
		return { show: `web login code: ${webAuth.issue()} (one login, ${minutes} minutes; not saved)` }
	},
}
