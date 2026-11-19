// The OpenAI provider: its known models, the claims in a ChatGPT token and
// the smaller context window of a subscription, with openai.ts loaded on
// first use.
import { auth, jwtClaims } from '../auth.ts'
import { modelsDev } from '../models-dev.ts'
import type { Provider } from '../provider.ts'
import { providers } from '../providers.ts'

const load = () => (require('../openai.ts') as typeof import('../openai.ts')).openai

function claims(token: string): { accountId?: string; api: boolean } {
	let c = jwtClaims(token)
	let id = c?.['https://api.openai.com/auth']?.chatgpt_account_id
	let api = [c?.scp, c?.scope].some((v) =>
		Array.isArray(v)
			? v.includes('api.responses.write')
			: typeof v === 'string' && v.split(/\s+/).includes('api.responses.write'),
	)
	return { ...(typeof id === 'string' && id && { accountId: id }), api }
}

function subscription(): boolean {
	try {
		let entry = auth.all('openai').list[0]?.entry
		return typeof entry?.accessToken === 'string' && !provider.claims(entry.accessToken).api
	} catch {
		return false
	}
}

function modelsKey(): string {
	try {
		return String(Bun.hash(JSON.stringify(auth.all('openai').list.map((a) => a.entry))))
	} catch {
		return 'unavailable'
	}
}

function contextWindow(model: string): number | undefined {
	let listed = modelsDev.contextWindow(`openai/${model}`)
	return provider.subscription() ? Math.min(listed ?? provider.subscriptionWindow, provider.subscriptionWindow) : listed
}

// GPT 5.3 and newer get OpenAI's web_search beside BRAVE (task a0z):
// gpt-6.2-sol, gpt-5.3-codex; not gpt-4.1 or gpt-5-mini.
function webSearch(model: string): boolean {
	let version = /^gpt-(\d+(?:\.\d+)?)/.exec(model)?.[1]
	return Number(version) >= 5.3
}

export const provider: Provider & {
	claims: typeof claims
	subscription: typeof subscription
	modelsKey: typeof modelsKey
	contextWindow: typeof contextWindow
	subscriptionWindow: number
	webSearch: typeof webSearch
} = {
	claims,
	subscription,
	modelsKey,
	contextWindow,
	subscriptionWindow: 272_000,
	webSearch,
	available: () => providers.available('openai'),
	request: (req) => load().request(req),
	parse: (messages) => load().parse(messages),
	open: (http, req) =>
		(require('../openai-ws.ts') as typeof import('../openai-ws.ts')).openaiWs.open(http, req, load().input),
	models: (signal) => load().listModels(signal),
	rejected: (account) => auth.rejected(account, 'openai'),
	spent: (account) => auth.spent(account, 'openai'),
}
