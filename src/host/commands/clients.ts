// /clients: the host, its peers and remote terminals and browsers as a
// diagram (task z8).

import type { SlashCommand } from '../commands.ts'
import { clients } from '../clients.ts'

export const command: SlashCommand = {
	help: () => '/clients draws the host with the peers on this machine beside it, and below them the remote terminals and browsers: address, what they follow and when they last spoke. Ones that left in the last 24 hours stay, marked gone.',
	run: (args) => (args ? { error: 'usage: /clients' } : { say: `\`\`\`\n${clients.draw()}\n\`\`\`` }),
}
