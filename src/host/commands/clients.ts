// /clients: the host, its peers and remote terminals and browsers as a
// diagram (task z8).

import type { SlashCommand } from '../commands.ts'
import { webAuth } from '../web-auth.ts'
import { clients } from '../clients.ts'

export const command: SlashCommand = {
	help: () => '/clients draws the host with the peers on this machine beside it, and below them the remote terminals and browsers: address, what they follow and when they last spoke. Ones that left in the last 24 hours stay, marked gone. Web logins show stable ids for /logout, device/browser, and first/last seen, including disconnected logins.',
	run: (args) => (args ? { error: 'usage: /clients' } : { say: `\`\`\`\n${clients.draw()}\n\nWeb logins (use /logout <id>):\n${webAuth.list().map((l) => `${l.id}  ${l.device}  first ${l.firstSeen ?? 'not recorded'}  last ${l.lastSeen ?? 'not recorded'}`).join('\n') || 'None.'}\n\`\`\`` }),
}
