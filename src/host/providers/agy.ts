// The Antigravity provider: Google's agent (`agy acp`) as a Hal model,
// with agy.ts loaded on first use (task xbp).
import type { Provider } from '../provider.ts'

const load = () => (require('../agy.ts') as typeof import('../agy.ts')).agy
const loadModels = () => (require('../agy-models.ts') as typeof import('../agy-models.ts')).agyModels

export const provider: Provider = {
	available: () => !!Bun.which('agy'),
	inTurnSteer: true,
	noAutoRetry: true,
	externalContext: true,
	request: () => ({ url: 'acp:agy', headers: {}, body: null }),
	open: (_http, req, signal) => load().open(req, signal),
	parse: (messages) => load().parse(messages),
	models: (signal) => load().models(signal),
	known: () => loadModels().known(),
	displayName: (model) => loadModels().displayName(model),
	contextWindow: (model) => loadModels().contextWindow(model),
	capability: (model) => loadModels().capability(model),
}
