import { auth, jwtClaims } from '../auth.ts'
import { modelsDev } from '../models-dev.ts'
import type { Provider } from '../provider.ts'
import { providers } from '../providers.ts'

const load = () => (require('../openai.ts') as typeof import('../openai.ts')).openai

function claims(token: string): { accountId?: string; api: boolean } {
	let c = jwtClaims(token)
	let id = c?.['https://api.openai.com/auth']?.chatgpt_account_id
	let api = [c?.scp, c?.scope].some((v) => (Array.isArray(v) ? v.includes('api.responses.write') : typeof v === 'string' && v.split(/\s+/).includes('api.responses.write')))
	return { ...(typeof id === 'string' && id && { accountId: id }), api }
}

function subscription(): boolean {
	try {
		let entry = auth.all('openai').list[0]?.entry
		return typeof entry?.accessToken === 'string' && !provider.claims(entry.accessToken).api
	} catch { return false }
}

function modelsKey(): string {
	try { return String(Bun.hash(JSON.stringify(auth.all('openai').list.map((a) => a.entry)))) }
	catch { return 'unavailable' }
}

function contextWindow(model: string): number | undefined {
	let listed = modelsDev.contextWindow(`openai/${model}`)
	return provider.subscription() ? Math.min(listed ?? provider.subscriptionWindow, provider.subscriptionWindow) : listed
}

export const provider: Provider & { claims: typeof claims; subscription: typeof subscription; modelsKey: typeof modelsKey; contextWindow: typeof contextWindow; subscriptionWindow: number; knownModels: string[] } = {
	claims, subscription, modelsKey, contextWindow,
	subscriptionWindow: 272_000,
	knownModels: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.5', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
	known: (): string[] => provider.knownModels,
	effort: (_model: string): string | undefined => undefined,
	available: () => providers.available('openai'),
	request: (req) => load().request(req),
	parse: (messages) => load().parse(messages),
	open: (http, req) => (require('../openai-ws.ts') as typeof import('../openai-ws.ts')).openaiWs.open(http, req, load().input),
	models: (signal) => load().listModels(signal),
	rejected: (account) => auth.rejected(account, 'openai'),
	spent: (account) => auth.spent(account, 'openai'),
}
