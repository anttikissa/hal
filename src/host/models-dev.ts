// Model metadata from models.dev (task qq): context windows, and model
// lists and names for providers that cannot list their own. The host
// fetches https://models.dev/api.json in the background at each start
// and keeps what Hal uses in state/models-dev.json, so it works offline
// from the cache and nothing waits on the fetch.
//
// The cache is JSON, not ASON: it is ~650 kB and rewritten whole at
// every start, and ASON takes ~100 ms to write and read it back.

import type { Pricing } from '../common/pricing.ts'
import { readFileSync, renameSync, writeFileSync } from 'fs'
import { diag } from './diag.ts'
import { paths } from './paths.ts'
import { provider } from './provider.ts'

export type ModelInfo = { name?: string; context?: number; pricing?: Pricing }
// models.dev provider id -> model id (without "provider/") -> info.
export type Catalog = Record<string, Record<string, ModelInfo>>

function file(): string {
	return `${paths.stateDir()}/models-dev.json`
}

// The cached catalog, read once; empty when there is none yet. A cache
// that does not parse is an error naming its path (tasks/README.md).
function catalog(): Catalog {
	let st = modelsDev.state
	if (st.catalog && st.path === modelsDev.file()) return st.catalog
	let text: string
	try {
		text = readFileSync(modelsDev.file(), 'utf-8')
	} catch (e: any) {
		if (e?.code !== 'ENOENT') throw e
		text = '{}'
	}
	try {
		st.catalog = JSON.parse(text) as Catalog
	} catch (e: any) {
		throw new Error(`${modelsDev.file()}: ${e?.message ?? e}`)
	}
	st.path = modelsDev.file()
	return st.catalog
}

// Keeps name and context of every model in the api.json answer.
function parse(data: unknown): Catalog {
	if (!data || typeof data !== 'object') throw new Error('models.dev: not an object')
	let out: Catalog = {}
	for (let [name, entry] of Object.entries(data as Record<string, any>)) {
		let models = entry?.models
		if (!models || typeof models !== 'object') continue
		let list: Record<string, ModelInfo> = {}
		for (let [id, raw] of Object.entries(models as Record<string, any>)) {
			let info: ModelInfo = {}
			if (typeof raw?.name === 'string') info.name = raw.name
			if (typeof raw?.limit?.context === 'number' && raw.limit.context > 0) info.context = raw.limit.context
			let cost = raw?.cost
			if (typeof cost?.input === 'number' && typeof cost?.output === 'number') {
				let prices: Pricing = { input: cost.input, output: cost.output }
				if (typeof cost.cache_read === 'number') prices.cacheRead = cost.cache_read
				if (typeof cost.cache_write === 'number') prices.cacheWrite = cost.cache_write
				if (Object.values(prices).some((n) => !Number.isFinite(n) || n < 0)) throw new Error(`models.dev: invalid cost for ${name}/${id}`)
				info.pricing = prices
			}
			list[id] = info
		}
		out[name] = list
	}
	return out
}

// Fetches the catalog and replaces the cache (atomically: a crash
// leaves the old one). Returns the ids ("provider/model") among
// `picked` the old cache listed and the new one does not; failures go
// to diagnostics only.
async function refresh(picked: string[] = []): Promise<string[]> {
	if (modelsDev.offline()) return []
	try {
		let res = await provider.fetch(modelsDev.url, { signal: AbortSignal.timeout(modelsDev.timeoutMs) })
		if (!res.ok) throw new Error(`HTTP ${res.status}`)
		let next = modelsDev.parse(await res.json())
		if (!Object.keys(next).length) throw new Error('no providers in the answer')
		let before = picked.filter((id) => modelsDev.info(id))
		let tmp = `${modelsDev.file()}.${process.pid}.tmp`
		writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 })
		renameSync(tmp, modelsDev.file())
		modelsDev.state.catalog = next
		modelsDev.state.path = modelsDev.file()
		return before.filter((id) => !modelsDev.info(id))
	} catch (e: any) {
		diag.log(`models.dev: ${e?.message ?? e}`)
		return []
	}
}

// What the cache says about "provider/model".
function info(id: string): ModelInfo | undefined {
	let slash = id.indexOf('/')
	if (slash < 0) return undefined
	return modelsDev.catalog()[id.slice(0, slash)]?.[id.slice(slash + 1)]
}

// The same model can be served under a provider absent from models.dev;
// prefer that provider's name, then another catalog entry for its id.
function displayName(id: string): string | undefined {
	let own = modelsDev.info(id)?.name
	if (own) return own
	let model = id.slice(id.indexOf('/') + 1)
	for (let entries of Object.values(modelsDev.catalog())) if (entries[model]?.name) return entries[model].name
	return undefined
}

// The provider's model ids (without "provider/"), newest cache; empty
// if models.dev does not know the provider.
function ids(name: string): string[] {
	return Object.keys(modelsDev.catalog()[name] ?? {})
}

// Context window of "provider/model" in tokens. A model its provider's
// entry does not know is looked up under any provider serving that id.
function contextWindow(id: string): number | undefined {
	let own = modelsDev.info(id)?.context
	if (own) return own
	let model = id.slice(id.indexOf('/') + 1)
	for (let list of Object.values(modelsDev.catalog())) if (list[model]?.context) return list[model].context
	return undefined
}

export const modelsDev = {
	state: { catalog: null as Catalog | null, path: '' },
	url: 'https://models.dev/api.json',
	timeoutMs: 10_000,
	// Tests (and ./run under bun test, which inherits NODE_ENV) never
	// reach models.dev; unit tests replace this and fake the fetch.
	offline: () => process.env.NODE_ENV === 'test',
	file,
	catalog,
	parse,
	refresh,
	info,
	displayName,
	ids,
	contextWindow,
}
