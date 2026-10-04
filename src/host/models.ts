// Model selection: the default model, short-name aliases, and the
// model picker's list.
//
// Plugin surface (models.*):
// - defaultModel(): the id a session uses until it picks one
//   → config.ason `model`
// - resolve(input): short name to an id, or the login granting access
//   "opus" → { id: 'anthropic/claude-opus-5-5' } | { login: '/login claude' };
//   a name it doesn't know → { id: input }
// - selection(input): resolve plus an effort suffix
//   "opus:high" → { id, effort: 'high' }; throws on no access
// - qualified(model, effort?): the reverse → "anthropic/claude-opus-5-5:high"
// - known(): ids offered without asking the network (synchronous)
// - list(current): the model picker's ids, current first
// - names(ids): display names from models.dev → { id: 'Claude Opus 5.5' }
// - valid(id): whether a session may switch to id
// - contextWindow(id): tokens id takes in, for the context meter
// - effort(id, selected?): the reasoning effort requests send
// - ttlMs: how long a provider's list is kept → 1 hour
// - timeoutMs: how long asking a provider may take → 3 s
// - fetchList(name): a provider's ids: cache, provider, then fallback
// - ask(name, list): calls the provider's own list under timeoutMs
// - fallback(name): models.dev ids, then the provider's built-in ones
// - cached(name): the cached listing, if still for the current key
// State: models.state.lists, provider name to its cached listing.
//
// Example: plugin.around(models, 'resolve', (next, input) =>
//   input === 'fast' ? { id: 'anthropic/claude-haiku-4-5' } : next(input))
//
// The model picker's list (tasks/w4/forms.md, Model picker) comes from
// here: every registered provider, plus Hal's synthetic models. A
// provider that can list its models is asked, at most once per ttlMs;
// one that cannot, or fails or is slow (asked again next time), gets
// its list from the models.dev cache (task qq) plus its built-in one.

import type { Pricing } from '../common/pricing.ts'
import { blocks } from '../common/blocks.ts'
import { picker } from '../common/picker.ts'
import { settings } from '../common/settings.ts'
import { existsSync } from 'fs'
import { apiKeys } from './api-keys.ts'
import { auth, type Kind } from './auth.ts'
import { diag } from './diag.ts'
import { modelsDev } from './models-dev.ts'
import { paths } from './paths.ts'
import { provider } from './provider.ts'
import { synthetic } from './synthetic.ts'
import { effort } from './effort.ts'

// One provider's model ids ("provider/model") and when they were got.
type Listing = { at: number; ids: string[]; key?: string }

async function fetchList(name: string): Promise<string[] | undefined> {
	let p = provider.state.providers[name]
	if (!p) return undefined
	let cached = models.cached(name)
	if (cached && Date.now() - cached.at < models.ttlMs) return cached.ids
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
	let key = provider.state.providers[name]?.modelsKey?.()
	let controller = new AbortController()
	let timer = setTimeout(() => controller.abort(), models.timeoutMs)
	try {
		let ids = (await Promise.race([
			list(controller.signal),
			new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('timed out')))),
		])).map((m) => `${name}/${m}`)
		if (key !== provider.state.providers[name]?.modelsKey?.()) return undefined
		models.state.lists.set(name, { at: Date.now(), ids, key })
		return ids
	} catch (e: any) {
		diag.log(`models of ${name}: ${e?.message ?? e}`)
		return undefined
	} finally {
		clearTimeout(timer)
	}
}

// Build the first picker from disk and in-memory caches, never from HTTP.
// Warm provider lists for later openings without holding this one up.
function list(current: string): string[] {
	void models.warm()
	return [...new Set([current, models.selection(models.defaultModel()).id, ...models.known()])]
}

// Asks every provider for its list; settles when all have answered,
// failed or timed out. Calls while one runs share it.
function warm(): Promise<void> {
	return (models.state.warming ??= Promise.all(Object.keys(provider.state.providers).map((name) => models.fetchList(name).catch((e) => diag.log(`models of ${name}: ${e}`)))).then(() => {}).finally(() => { models.state.warming = undefined }))
}

// The ids known without asking anyone: synthetic ones, and each
// provider's cached list, else its models.dev and built-in ones.
function known(): string[] {
	let lists = Object.keys(provider.state.providers).map((name) => {
		let ids = models.cached(name)?.ids
		if (ids) return ids
		return models.fallback(name).map((m) => `${name}/${m}`)
	})
	return [...Object.keys(synthetic.models).map((m) => `hal/${m}`), ...lists.flat()]
}

// Display names models.dev gives the ids it knows.
function names(ids: string[]): Record<string, string> {
	let out: Record<string, string> = {}
	for (let id of ids) {
		let name = modelsDev.displayName(id)
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

// Short names choose the family's preferred model, then a provider we can
// actually use. Subscriptions take precedence over metered API keys.
function resolve(input: string): { id?: string; login?: string } {
	// sol is the old Hal's other name for gpt.
	let family = input.toLowerCase() === 'sol' ? 'gpt' : input.toLowerCase()
	// opus-5.5, opus5.5, opus-5-5 (task kh): that Claude, if it exists.
	let claude = /^(opus|sonnet|haiku|fable)-?(\d+)(?:[.-](\d+))?$/.exec(family)
	if (claude) {
		let id = `anthropic/claude-${claude[1]}-${claude[2]}${claude[3] ? `-${claude[3]}` : ''}`
		if (!models.known().includes(id)) return { id: input }
		let access = models.resolve(claude[1]!)
		return access.id ? { id } : access
	}
	let version = /^gpt-?(6(?:\.1)?)$/.exec(family)?.[1]
	if (!version && !['gpt', 'claude', 'opus', 'astra', 'luna', 'sonnet', 'fable', 'haiku', 'kimi', 'qwen', 'deepseek', 'glm', 'minimax'].includes(family)) return { id: input }
	let popular: Record<string, string> = { astra: 'openai/gpt-6-astra', luna: 'openai/gpt-6-luna', sonnet: 'anthropic/claude-sonnet-5-5', fable: 'anthropic/claude-fable-5-1', haiku: 'anthropic/claude-haiku-4-5' }
	let own = family === 'gpt' || version || family === 'astra' || family === 'luna' ? 'openai' : family === 'claude' || family === 'opus' || family === 'sonnet' || family === 'fable' || family === 'haiku' ? 'anthropic' : undefined
	let needle = family === 'claude' || family === 'opus' ? 'opus' : family
	let candidates = models.known().filter((id) => version ? id.startsWith(`openai/gpt-${version}-`) : id.split('/').slice(1).join('/').toLowerCase().includes(needle))
	let preferred = version ? `openai/gpt-${version}-sol` : popular[family] ?? (family === 'gpt' ? picker.defaults.gpt : own ? picker.defaults.opus : undefined)
	if (preferred) candidates = [preferred, ...candidates.filter((id) => id !== preferred)]
	let providers = own ? [own] : ['opencode-go', 'openrouter']
	for (let name of providers) {
		let available = name === 'openai' || name === 'anthropic'
			? !!(auth.envKey(name as Kind) || (existsSync(paths.authFile()) && auth.accounts(auth.store(), name as Kind).length))
			: !!(apiKeys.get(name === 'opencode-go' ? 'opencode' : name) || process.env[name === 'opencode-go' ? 'OPENCODE_API_KEY' : 'OPENROUTER_API_KEY'])
		if (!available) continue
		let found = candidates.find((id) => id.startsWith(`${name}/`))
		if (found) return { id: found }
	}
	return { login: own === 'openai' ? '/login chatgpt' : own === 'anthropic' ? '/login claude' : '/login opencode or /login openrouter' }
}

export const models = {
	state: { lists: new Map<string, Listing>(), warming: undefined as Promise<void> | undefined },
	// provider/model id used when a session has not chosen one:
	// config.ason's `model`.
	defaultModel(): string {
		return settings.model()
	},
	// How long a provider's list is kept, and how long it may take.
	ttlMs: 3_600_000,
	timeoutMs: 3000,
	cached(name: string): Listing | undefined {
		let entry = models.state.lists.get(name)
		return entry?.key === provider.state.providers[name]?.modelsKey?.() ? entry : undefined
	},
	fetchList,
	ask,
	list,
	warm,
	names,
	resolve,
	// List prices, not subscription charges. Unknown prices stay unknown.
	pricing(id: string): Pricing | undefined {
		return modelsDev.info(id)?.pricing ?? (id === 'anthropic/claude-opus-5-5' ? { input: 4, output: 20, cacheRead: .2, cacheWrite: 5 } : undefined)
	},
	// Tokens `id` can take in, if known: for the context meter.
	contextWindow(id: string): number | undefined {
		let parsed = blocks.parseModelId(id)
		let own = parsed && provider.state.providers[parsed.provider]?.contextWindow?.(parsed.model)
		return own ?? modelsDev.contextWindow(id)
	},
	// The reasoning effort requests for `id` set, if any (task hp).
	effort(id: string, selected?: string): string | undefined {
		let parsed = blocks.parseModelId(id)
		return selected ?? effort.describe(id)?.policy ?? (parsed && provider.state.providers[parsed.provider]?.effort?.(parsed.model))
	},
	selection(input: string): { id: string; effort?: string } {
		let base = input
		let level: string | undefined
		if (!models.known().includes(input)) {
			let colon = input.lastIndexOf(':')
			if (colon >= 0) {
				let suffix = input.slice(colon + 1)
				let candidate = input.slice(0, colon)
				let alias = models.resolve(candidate)
				if (suffix === 'default' || effort.vocabulary.includes(suffix as any)) { base = candidate; level = suffix }
				else if (models.known().includes(candidate) || alias.id !== candidate || alias.login) throw new Error(`${candidate}: unknown effort '${suffix}'; use default or ${alias.id ? effort.describe(alias.id)?.levels.join(', ') || 'no verified effort control' : 'a supported level'}`)
			}
		}
		let choice = models.resolve(base)
		if (!choice.id) throw new Error(`${base}: no access; ${choice.login} to use it`)
		return { id: choice.id, ...(level && level !== 'default' ? { effort: effort.validate(choice.id, level) } : {}) }
	},
	qualified(model: string, selected?: string): string { return selected === undefined ? model : `${model}:${selected}` },
	fallback,
	known,
	valid,
}
