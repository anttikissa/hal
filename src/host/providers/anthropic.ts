import { auth } from '../auth.ts'
import type { Provider } from '../provider.ts'
import { providers } from '../providers.ts'

const load = () => (require('../anthropic.ts') as typeof import('../anthropic.ts')).anthropic

export const provider: Provider & { knownModels: string[]; webSearchModels: string[] } = {
	knownModels: [
		'claude-opus-5-5',
		'claude-sonnet-5-5',
		'claude-opus-5',
		'claude-fable-5-1',
		'claude-fable-5',
		'claude-sonnet-5',
	],
	// Models offered Anthropic's web_search when Serper is unavailable (task a0z).
	webSearchModels: [
		'claude-opus-5-5',
		'claude-sonnet-5-5',
		'claude-opus-5',
		'claude-fable-5-1',
		'claude-fable-5',
		'claude-sonnet-5',
	],
	known: () => provider.knownModels,
	available: () => providers.available('anthropic'),
	request: (req) => load().request(req),
	parse: (messages) => load().parse(messages),
	models: (signal) => load().models(signal),
	rejected: (account) => auth.rejected(account),
	spent: (account) => auth.spent(account),
}
