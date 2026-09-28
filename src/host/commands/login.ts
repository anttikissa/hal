// /login claude: log this home in to a Claude subscription (login.ts).
// The pasted code is a secret field, so history records only that it
// was given. Users subscribe to Claude, not to "Anthropic", so claude is
// the name; anthropic, the provider prefix in model ids, is an alias.
// Likewise chatgpt, with openai as its alias: a device-code login
// (login-chatgpt.ts) that shows a URL and code, then waits.
// /login opencode stores an OpenCode Go API key (api-keys.ts): the key
// is the whole credential, so there is no OAuth round trip.

import type { SlashCommand } from '../commands.ts'
import { apiKeys } from '../api-keys.ts'
import { login } from '../login.ts'
import { chatgptLogin } from '../login-chatgpt.ts'

const PROVIDERS = ['claude', 'chatgpt', 'opencode']
const ALIASES: Record<string, string> = { claude: 'claude', anthropic: 'claude', chatgpt: 'chatgpt', openai: 'chatgpt', opencode: 'opencode', 'opencode-go': 'opencode' }
const KEYS = 'API keys: set ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENCODE_API_KEY or OPENROUTER_API_KEY'

export const command: SlashCommand = {
	help: () =>
		'/login claude | chatgpt: log this home in to a Claude or ChatGPT subscription; the tokens go to its credentials file. /login opencode: store an OpenCode Go API key there. An API key in ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENCODE_API_KEY (or OPENROUTER_API_KEY for openrouter) works without logging in.',
	complete: (args) => PROVIDERS.filter((p) => p.startsWith(args)),
	async run(args, answers, ctx) {
		let which = ALIASES[args.trim()]
		if (!which) {
			let what = args.trim() ? `${args.trim()}: no such provider` : 'which provider?'
			return { error: `${what} /login ${PROVIDERS.join(' | ')} (${KEYS})` }
		}
		if (which === 'chatgpt') {
			let email = await chatgptLogin.run((text) => ctx.say(text))
			return { say: `logged in to ChatGPT${email ? ` as ${email}` : ''}` }
		}
		if (which === 'opencode') {
			if (!answers) return { ask: { text: 'Paste your OpenCode Go API key.', fields: [{ type: 'secret', name: 'key', label: 'API key' }] } }
			let key = answers.key?.trim() ?? ''
			if (!key) return { error: 'no key given; /login opencode to try again' }
			apiKeys.save('opencode-go', key)
			return { say: 'logged in to OpenCode Go' }
		}
		if (!answers) {
			let url = await login.url()
			return { ask: { text: `Open this URL to log in to Claude:\n\n${url}\n\nThen paste the code#state value the page shows.`, fields: [{ type: 'secret', name: 'code', label: 'code#state' }] } }
		}
		let email = await login.finish(answers.code ?? '')
		return { say: `logged in to Claude${email ? ` as ${email}` : ''}` }
	},
}
