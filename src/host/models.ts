// Model selection. Config values are functions read at call time, so
// local.ts can replace them (see tasks/README.md).
//
// The model picker's list (tasks/w4/forms.md, Model picker) comes from
// here: every registered provider, plus Hal's synthetic models. A
// provider that can list its models is asked, at most once per ttlMs;
// one that cannot, or fails or is slow (asked again next time), gets
// its list from the models.dev cache (task qq) plus its built-in one.

import { blocks } from '../common/blocks.ts'
import { settings } from '../common/settings.ts'
import { diag } from './diag.ts'
import { modelsDev } from './models-dev.ts'
import { provider } from './provider.ts'
import { synthetic } from './synthetic.ts'

// One provider's model ids ("provider/model") and when they were got.
type Listing = { at: number; ids: string[] }

async function fetchList(name: string): Promise<string[] | undefined> {
	let p = provider.state.providers[name]
	if (!p) return undefined
	let cached = models.state.lists.get(name)
	if (cached && Date.now() - cached.at < models.ttlMs()) return cached.ids
	let own = p.models ? await models.ask(name, (signal) => p.models!(signal)) : undefined
	if (own) return own
	let fallback = models.fallback(name)
	return fallback.length ? fallback.map((m) => `${name}/${m}`) : undefined
}

// models.dev's ids for provider `name`, then its built-in ones.
function fallback(name: string): string[] {
	return [...new Set([...modelsDev.ids(name), ...(provider.state.providers[name]?.known?.() ?? [])])]
}

// The provider's own list, or undefined if it failed or took too long.
async function ask(name: string, list: (signal: AbortSignal) => Promise<string[]>): Promise<string[] | undefined> {
	let controller = new AbortController()
	let timer = setTimeout(() => controller.abort(), models.timeoutMs())
	try {
		let ids = (await Promise.race([
			list(controller.signal),
			new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('timed out')))),
		])).map((m) => `${name}/${m}`)
		models.state.lists.set(name, { at: Date.now(), ids })
		return ids
	} catch (e: any) {
		diag.log(`models of ${name}: ${e?.message ?? e}`)
		return undefined
	} finally {
		clearTimeout(timer)
	}
}

// Every model id to offer, `current` first, then the default, the
// synthetic ones and each provider's in registration order.
async function list(current: string): Promise<string[]> {
	let lists = await Promise.all(Object.keys(provider.state.providers).map((name) => models.fetchList(name)))
	let hal = Object.keys(synthetic.models).map((m) => `hal/${m}`)
	return [...new Set([current, models.defaultModel(), ...hal, ...lists.flatMap((l) => l ?? [])])]
}

// The ids known without asking anyone: synthetic ones, and each
// provider's cached list, else its models.dev and built-in ones.
function known(): string[] {
	let lists = Object.keys(provider.state.providers).map((name) => {
		let ids = models.state.lists.get(name)?.ids
		if (ids) return ids
		return models.fallback(name).map((m) => `${name}/${m}`)
	})
	return [...Object.keys(synthetic.models).map((m) => `hal/${m}`), ...lists.flat()]
}

// Display names models.dev gives the ids it knows.
function names(ids: string[]): Record<string, string> {
	let out: Record<string, string> = {}
	for (let id of ids) {
		let name = modelsDev.info(id)?.name
		if (name) out[id] = name
	}
	return out
}

// Whether a session may switch to `id`: a synthetic model, or any
// model of a registered provider (lists are not complete: a provider
// may serve models it does not list).
function valid(id: string): boolean {
	if (/\s/.test(id)) return false
	if (id.startsWith('hal/')) return !!synthetic.find(id)
	let slash = id.indexOf('/')
	return slash > 0 && slash < id.length - 1 && !!provider.state.providers[id.slice(0, slash)]
}

export const models = {
	state: { lists: new Map<string, Listing>() },
	// provider/model id used when a session has not chosen one:
	// config.ason's `model`.
	defaultModel(): string {
		return settings.model()
	},
	// How long a provider's list is kept, and how long it may take.
	ttlMs: () => 3_600_000,
	timeoutMs: () => 3000,
	fetchList,
	ask,
	list,
	names,
	// Tokens `id` can take in, if known: for the context meter.
	contextWindow(id: string): number | undefined {
		let parsed = blocks.parseModelId(id)
		let own = parsed && provider.state.providers[parsed.provider]?.contextWindow?.(parsed.model)
		return own ?? modelsDev.contextWindow(id)
	},
	// The reasoning effort requests for `id` set, if any (task hp).
	effort(id: string): string | undefined {
		let parsed = blocks.parseModelId(id)
		return parsed && provider.state.providers[parsed.provider]?.effort?.(parsed.model)
	},
	fallback,
	known,
	valid,
}
