// Model metadata from models.dev (task qq): context windows, and model
// lists and names for providers that cannot list their own. The host
// fetches https://models.dev/api.json in the background at each start
// and keeps what Hal uses in state/models-dev.json, so it works offline
// from the cache and nothing waits on the fetch.
//
// The cache is JSON, not ASON: it is ~650 kB and rewritten whole at
// every start, and ASON takes ~100 ms to write and read it back.

import type { Pricing } from '../common/pricing.ts'
import { readFileSync } from 'fs'
import { diag } from './diag.ts'
import { modelsDevWorker } from './models-dev-worker.ts'
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
	st.catalog = modelsDev.lazy(text, modelsDev.file())
	st.path = modelsDev.file()
	return st.catalog
}

// The cache holds one provider per line (modelsDev.serialize): each is
// parsed on first use, as parsing all ~1 MB took ~10 ms (task 7j). A
// line that does not parse is an error naming `path`.
function lazy(text: string, path: string): Catalog {
	let parse = (s: string) => {
		try {
			return JSON.parse(s)
		} catch (e: any) {
			throw new Error(`${path}: ${e?.message ?? e}`)
		}
	}
	let lines = text.split('\n')
	if (lines.length < 3) return parse(text)
	let out: Catalog = {}
	for (let line of lines.slice(1, -1)) {
		let key = line.match(/^"(?:[^"\\]|\\.)*"(?=:)/)?.[0]
		if (!key) throw new Error(`${path}: not one provider per line: ${line.slice(0, 80)}`)
		let name = parse(key) as string
		Object.defineProperty(out, name, {
			enumerable: true,
			configurable: true,
			get: () => {
				let value = parse(`{${line.replace(/,$/, '')}}`)[name]
				Object.defineProperty(out, name, { value, enumerable: true, configurable: true, writable: true })
				return value
			},
		})
	}
	return out
}

// The catalog as cached: JSON, one provider per line.
function serialize(catalog: Catalog): string {
	return `{\n${Object.entries(catalog).map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(',\n')}\n}`
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

// Fetches the catalog and replaces the cache (in a worker: task 7j).
// Returns the ids ("provider/model") among `picked` the old cache
// listed and the new one does not; failures go to diagnostics only.
async function refresh(picked: string[] = []): Promise<string[]> {
	if (modelsDev.offline()) return []
	try {
		let res = await provider.fetch(modelsDev.url, { signal: AbortSignal.timeout(modelsDev.timeoutMs) })
		if (!res.ok) throw new Error(`HTTP ${res.status}`)
		let body = await res.arrayBuffer()
		let before = picked.filter((id) => modelsDev.info(id))
		let reply = await modelsDevWorker.run({ body, file: modelsDev.file(), tmp: `${modelsDev.file()}.${process.pid}.tmp` })
		if ('error' in reply) throw new Error(reply.error)
		modelsDev.state.catalog = modelsDev.lazy(reply.json, modelsDev.file())
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
	lazy,
	serialize,
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
