import type { SlashCommand } from '../commands.ts'
import { webAuth } from '../web-auth.ts'
import { web } from '../web.ts'

export const command: SlashCommand = {
	help: () => '/logout <client id|all> revokes web logins listed by /clients and closes their open connections immediately. A browser needs a new login code.',
	complete: (args) => ['all', ...webAuth.list().map((l) => l.id)].filter((id) => id.startsWith(args)),
	run(args) {
		if (args !== 'all' && !webAuth.list().some((l) => l.id === args)) return { error: 'usage: /logout <client id|all> — /clients lists web login ids' }
		return { say: `${web.revoke(args)} web login(s) revoked; a browser needs a new code` }
	},
}
