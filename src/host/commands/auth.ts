// /auth: a one-time code for logging a browser in (host/web-auth.ts),
// shown to this tab's clients but never recorded; /auth revoke logs
// every browser out.

import type { SlashCommand } from '../commands.ts'
import { webAuth } from '../web-auth.ts'
import { web } from '../web.ts'

export const command: SlashCommand = {
	help: () =>
		'/auth [count] shows one-time login codes for browsers or remote terminals (default: 1, max: 100). Each works once, for 10 minutes. `hal auth [count]` in a shell prints them too. Use a different code for each device.\n/auth revoke logs every browser out.',
	complete: (args) => ('revoke'.startsWith(args) ? ['revoke'] : []),
	run(args) {
		if (args === 'revoke') {
			web.revoke()
			return { say: 'every web session ended; a browser needs a new code' }
		}
		if (args && (!/^\d+$/.test(args) || +args < 1 || +args > 100))
			return { error: 'usage: /auth [count: 1-100] or /auth revoke' }
		return { show: webAuth.message(Array.from({ length: args ? +args : 1 }, () => webAuth.issue())) }
	},
}
