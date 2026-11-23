// The Antigravity provider: Google's agent (`agy acp`) as a Hal model,
// with agy.ts loaded on first use (task xbp).
import type { Provider } from '../provider.ts'

const load = () => (require('../agy.ts') as typeof import('../agy.ts')).agy

export const provider: Provider = {
	available: () => !!Bun.which('agy'),
	inTurnSteer: true,
	noAutoRetry: true,
	request: () => ({ url: 'acp:agy', headers: {}, body: null }),
	open: (_http, req, signal) => load().open(req, signal),
	parse: (messages) => load().parse(messages),
	models: async () => load().models(),
	known: () => load().known(),
	contextWindow: () => 1_048_576,
	capability: (model) => load().capability(model),
}
