// The Antigravity provider: Google's agent (`agy acp`) as a Hal model,
// with agy.ts loaded on first use (task xbp).
import type { Provider } from '../provider.ts'

let loaded: typeof import('../agy.ts').agy | undefined
const load = () => (loaded ??= (require('../agy.ts') as typeof import('../agy.ts')).agy)
const loadAccounts = () => (require('../agy-accounts.ts') as typeof import('../agy-accounts.ts')).agyAccounts
const loadModels = () => (require('../agy-models.ts') as typeof import('../agy-models.ts')).agyModels

export const provider: Provider = {
	available: () => !!Bun.which('agy'),
	inTurnSteer: true,
	noAutoRetry: true,
	externalContext: true,
	request: (req) => ({
		url: 'acp:agy',
		headers: {},
		body: null,
		account: loadAccounts().pick(req.model, req.sessionId).name,
	}),
	open: (http, req, signal) => load().open(req, signal, http.account),
	parse: (messages) => load().parse(messages),
	models: (signal) => load().models(signal),
	known: () => loadModels().known(),
	displayName: (model) => loadModels().displayName(model),
	contextWindow: (model) => loadModels().contextWindow(model),
	capability: (model) => loadModels().capability(model),
	stop: (sessionId) => loaded?.stop(sessionId),
	stopAll: () => loaded?.stopAll(),
}
