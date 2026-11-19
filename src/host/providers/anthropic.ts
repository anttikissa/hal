// The Anthropic provider, with anthropic.ts loaded on first use.
import { auth } from '../auth.ts'
import type { Provider } from '../provider.ts'
import { providers } from '../providers.ts'

const load = () => (require('../anthropic.ts') as typeof import('../anthropic.ts')).anthropic

export const provider: Provider = {
	available: () => providers.available('anthropic'),
	request: (req) => load().request(req),
	parse: (messages) => load().parse(messages),
	models: (signal) => load().models(signal),
	rejected: (account) => auth.rejected(account),
	spent: (account) => auth.spent(account),
}
