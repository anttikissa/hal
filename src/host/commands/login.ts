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
const ALIASES: Record<string, string> = { claude: 'claude', anthropic: 'claude', chatgpt: 'chatgpt', openai: 'chatgpt', opencode: 'opencode', 'opencode-go': 'opencode', 'claude-key': 'anthropic-key', 'chatgpt-key': 'openai-key' }
const METHODS: Record<string, string> = {
	'Claude subscription': 'claude', 'ChatGPT subscription': 'chatgpt',
	'Claude API key': 'anthropic-key', 'ChatGPT API key': 'openai-key',
	'OpenCode API key': 'opencode-go-key', 'OpenRouter API key': 'openrouter-key',
}
const KEYS = 'API keys: set ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENCODE_API_KEY or OPENROUTER_API_KEY'

export const command: SlashCommand = {
	help: () => '/login: choose a Claude or ChatGPT subscription login, or paste an API key for Claude, ChatGPT, OpenCode or OpenRouter. /login claude | chatgpt | opencode also work directly; keys may instead be set in environment variables.',
	complete: (args) => PROVIDERS.filter((p) => p.startsWith(args)),
	async run(args, answers, ctx) {
		let selected = args.trim()
		if (!selected && !answers) return { ask: { text: chatgptLogin.local() ? 'Select authentication method.' : 'Select authentication method. For ChatGPT subscription login, first turn on Enable device code sign-in at https://chatgpt.com/#settings/Security', fields: [{ type: 'choice', name: 'method', options: Object.keys(METHODS), initial: 0 }] } }
		if (!selected) selected = METHODS[answers?.method ?? ''] ?? ''
		let which = ALIASES[selected] ?? selected
		if (!['claude', 'chatgpt', 'opencode', 'anthropic-key', 'openai-key', 'opencode-go-key', 'openrouter-key'].includes(which)) {
			return { error: `${selected || 'unknown method'}: no such login method; /login ${PROVIDERS.join(' | ')} (${KEYS})` }
		}
		if (which === 'chatgpt') {
			let email = await chatgptLogin.run((text) => ctx.say(text))
			return { say: `logged in to ChatGPT${email ? ` as ${email}` : ''}` }
		}
		if (which === 'opencode' || which.endsWith('-key')) {
			let provider = which === 'opencode' ? 'opencode-go' : which.slice(0, -4)
			if (!answers || answers.method !== undefined) return { ask: { text: `Paste your ${provider} API key.`, fields: [{ type: 'secret', name: 'key', label: 'API key' }] }, askArgs: which }
			let key = answers.key?.trim() ?? ''
			if (!key) return { error: 'no key given; /login to try again' }
			apiKeys.save(provider, key)
			return { say: `logged in to ${provider === 'opencode-go' ? 'OpenCode Go' : provider} with an API key` }
		}
		if (!answers || answers.method !== undefined) {
			let url = await login.url()
			return { ask: { text: `Open this URL to log in to Claude:\n\n${url}\n\nThen paste the code#state value the page shows.`, fields: [{ type: 'secret', name: 'code', label: 'code#state' }] }, askArgs: which }
		}
		let email = await login.finish(answers.code ?? '')
		return { say: `logged in to Claude${email ? ` as ${email}` : ''}` }
	},
}
