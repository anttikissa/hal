// The Anthropic provider: which models get hosted web search, with
// anthropic.ts loaded on first use.
import { auth } from '../auth.ts'
import type { Provider } from '../provider.ts'
import { providers } from '../providers.ts'

const load = () => (require('../anthropic.ts') as typeof import('../anthropic.ts')).anthropic

// Claude 5 and newer get Anthropic's web_search beside BRAVE (task a0z):
// claude-opus-5-5, claude-fable-5-2; not claude-3-5-sonnet or claude-opus-4-1.
function webSearch(model: string): boolean {
	let major = /^claude-(?:[a-z]+-)?(\d+)/.exec(model)?.[1]
	return Number(major) >= 5
}

export const provider: Provider & { webSearch: typeof webSearch } = {
	webSearch,
	available: () => providers.available('anthropic'),
	request: (req) => load().request(req),
	parse: (messages) => load().parse(messages),
	models: (signal) => load().models(signal),
	rejected: (account) => auth.rejected(account),
	spent: (account) => auth.spent(account),
}
