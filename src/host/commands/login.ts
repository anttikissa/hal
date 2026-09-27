// /login claude: log this home in to a Claude subscription (login.ts).
// The pasted code is a secret field, so history records only that it
// was given. Users subscribe to Claude, not to "Anthropic", so claude is
// the name; anthropic, the provider prefix in model ids, is an alias.

import type { SlashCommand } from '../commands.ts'
import { login } from '../login.ts'

const PROVIDERS = ['claude']
const ALIASES: Record<string, string> = { claude: 'claude', anthropic: 'claude' }

export const command: SlashCommand = {
	description: 'log in to a provider',
	category: 'session',
	help: () => '/login claude: log this home in to a Claude subscription; the tokens go to its credentials file. An API key in ANTHROPIC_API_KEY (or OPENROUTER_API_KEY for openrouter) works without logging in.',
	complete: (args) => PROVIDERS.filter((p) => p.startsWith(args)),
	async run(args, answers) {
		if (ALIASES[args.trim()] !== 'claude') {
			let what = args.trim() ? `${args.trim()}: no such provider` : 'which provider?'
			return { error: `${what} /login ${PROVIDERS.join(' | ')} (API keys: set ANTHROPIC_API_KEY or OPENROUTER_API_KEY)` }
		}
		if (!answers) {
			let url = await login.url()
			return { ask: { text: `Open this URL to log in to Claude:\n\n${url}\n\nThen paste the code#state value the page shows.`, fields: [{ type: 'secret', name: 'code', label: 'code#state' }] } }
		}
		let email = await login.finish(answers.code ?? '')
		return { say: `logged in to Claude${email ? ` as ${email}` : ''}` }
	},
}
