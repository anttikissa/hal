// Model metadata infrastructure: models.dev cache, refresh, credentials, and context limits.

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { auth } from './auth.ts'
import { models } from '../common/models.ts'
import { STATE_DIR, ensureDir } from './state.ts'
import { ason } from '../utils/ason.ts'

export interface ModelSource {
	provider: string
	context: number
	output?: number
	status?: string
}

export interface ModelMetadata {
	context: number
	output?: number
	name?: string
	description?: string
	family?: string
	releaseDate?: string
	updatedAt?: string
	sources: ModelSource[]
}

/** Base URL and env var names models.dev publishes for a provider. */
export interface ProviderInfo {
	api: string
	env: string[]
}

interface ModelsDevCache {
	version: 1
	models: Record<string, ModelMetadata>
	providers?: Record<string, ProviderInfo>
}

export interface RefreshModelsResult {
	fetched: boolean
	changes: string[]
	modelCount: number
	hadCache: boolean
	previous: Record<string, number>
	next: Record<string, number>
}

const state = {
	metadata: null as Record<string, ModelMetadata> | null,
	providers: null as Record<string, ProviderInfo> | null,
}

function modelsFile(): string {
	return `${process.env.HAL_STATE_DIR ?? STATE_DIR}/models.ason`
}

function contextWindows(metadata: Record<string, ModelMetadata>): Record<string, number> {
	const contexts: Record<string, number> = {}
	for (const [id, model] of Object.entries(metadata)) contexts[id] = model.context
	return contexts
}

/**
 * Models per registry provider, excluding the curated direct providers already
 * rendered by the picker. The common registry uses this to offer tab completion
 * and picker entries for providers like opencode-go without hardcoding each one.
 */
function registryProviderModels(metadata: Record<string, ModelMetadata>): Record<string, string[]> {
	const direct = new Set(['hal', 'anthropic', 'openai', 'google', 'openrouter'])
	const byProvider: Record<string, Set<string>> = {}
	for (const [modelId, model] of Object.entries(metadata)) {
		for (const source of model.sources) {
			if (direct.has(source.provider)) continue
			;(byProvider[source.provider] ??= new Set()).add(modelId)
		}
	}
	const result: Record<string, string[]> = {}
	for (const [provider, ids] of Object.entries(byProvider)) result[provider] = [...ids].sort()
	return result
}


/** Every "vendor/model" id OpenRouter serves, newest release first. */
function openrouterIds(metadata: Record<string, ModelMetadata>): string[] {
	const ids: string[] = []
	for (const [id, model] of Object.entries(metadata)) {
		if (!id.includes('/')) continue
		if (!model.sources.some((source) => source.provider === 'openrouter')) continue
		ids.push(id)
	}
	ids.sort((a, b) => (metadata[b]!.releaseDate ?? '').localeCompare(metadata[a]!.releaseDate ?? '') || a.localeCompare(b))
	return ids
}

/** Load persisted discovery data and hydrate the runtime-neutral model registry. */
function loadModelsDevCache(): Record<string, number> {
	if (models.state.cache) return models.state.cache
	try {
		const parsed = ason.parse(readFileSync(modelsFile(), 'utf-8')) as unknown as ModelsDevCache
		state.metadata = parsed.models
		state.providers = parsed.providers ?? {}
		models.hydrate(contextWindows(parsed.models), openrouterIds(parsed.models), parsed.models, registryProviderModels(parsed.models))
	} catch {
		models.hydrate({})
		state.metadata = {}
		state.providers = {}
	}
	return models.state.cache!
}

/**
 * Base URL and env var names for a provider, as published by models.dev. Lets the
 * OpenAI-compatible provider and auth reach ~195 providers without hardcoding each
 * one; the hardcoded tables remain as seeds for a cold cache.
 */
function providerInfo(providerName: string): ProviderInfo | undefined {
	if (!state.providers) loadModelsDevCache()
	return state.providers?.[providerName]
}

function init(): void {
	loadModelsDevCache()
}

function cachedModelMetadata(fullId: string): ModelMetadata | undefined {
	loadModelsDevCache()
	const bare = fullId.includes('/') ? fullId.slice(fullId.indexOf('/') + 1) : fullId
	return state.metadata?.[bare] ?? state.metadata?.[fullId]
}

function hasConfiguredDirectSource(fullId: string): boolean {
	const metadata = cachedModelMetadata(fullId)
	if (!metadata) return false
	for (const source of metadata.sources) {
		if (!['anthropic', 'openai', 'google', 'openrouter'].includes(source.provider)) continue
		if (auth.getCredential(source.provider)) return true
	}
	return false
}

function canonicalNameProvider(id: string): string {
	if (id.includes('/')) return 'openrouter'
	if (id.startsWith('gpt-') || id.startsWith('o') || id.startsWith('codex')) return 'openai'
	if (id.startsWith('claude-')) return 'anthropic'
	if (id.startsWith('gemini-')) return 'google'
	return ''
}

function modelsDevMetadata(data: Record<string, { models?: Record<string, any> }>): Record<string, ModelMetadata> {
	const metadata: Record<string, ModelMetadata> = {}
	// One id is listed by several provider catalogs. The canonical route wins;
	// sorting supplies a stable fallback when that catalog has no name.
	for (const [provider, catalog] of Object.entries(data).sort(([a], [b]) => a.localeCompare(b))) {
		for (const [id, raw] of Object.entries(catalog.models ?? {})) {
			const context = raw.limit?.context
			if (typeof context !== 'number') continue
			let model = metadata[id]
			if (!model) {
				model = { context, sources: [] }
				metadata[id] = model
			}
			if (context > model.context) model.context = context
			if (typeof raw.limit?.output === 'number' && (!model.output || raw.limit.output > model.output)) model.output = raw.limit.output
			if (typeof raw.name === 'string' && (!model.name || provider === canonicalNameProvider(id))) model.name = raw.name
			if (typeof raw.description === 'string') model.description = raw.description
			if (typeof raw.family === 'string') model.family = raw.family
			if (typeof raw.release_date === 'string') model.releaseDate = raw.release_date
			if (typeof raw.last_updated === 'string') model.updatedAt = raw.last_updated
			const source: ModelSource = { provider, context }
			if (typeof raw.limit?.output === 'number') source.output = raw.limit.output
			if (typeof raw.status === 'string') source.status = raw.status
			model.sources.push(source)
		}
	}
	for (const model of Object.values(metadata)) model.sources.sort((a, b) => a.provider.localeCompare(b.provider))
	return metadata
}

/** Endpoint and env var names per provider, for the ones that publish both. */
function modelsDevProviders(data: Record<string, { api?: string; env?: string[] }>): Record<string, ProviderInfo> {
	const providers: Record<string, ProviderInfo> = {}
	for (const [id, entry] of Object.entries(data)) {
		if (typeof entry.api !== 'string' || !Array.isArray(entry.env) || entry.env.length === 0) continue
		providers[id] = { api: entry.api, env: entry.env }
	}
	return providers
}

async function refreshModels(): Promise<RefreshModelsResult> {
	const hadCache = existsSync(modelsFile())
	const previous = hadCache ? loadModelsDevCache() : {}
	const res = await fetch('https://models.dev/api.json', { signal: AbortSignal.timeout(10_000) })
	const data = (await res.json()) as Record<string, { models?: Record<string, any>; api?: string; env?: string[] }>
	const metadata = modelsDevMetadata(data)
	const providers = modelsDevProviders(data)
	const next = contextWindows(metadata)
	ensureDir(process.env.HAL_STATE_DIR ?? STATE_DIR)
	const cache: ModelsDevCache = { version: 1, models: metadata, providers }
	writeFileSync(modelsFile(), ason.stringify(cache) + '\n')
	models.hydrate(next, openrouterIds(metadata), metadata, registryProviderModels(metadata))
	state.metadata = metadata
	state.providers = providers
	return {
		fetched: true,
		changes: hadCache ? models.modelChangeMessages(previous, next) : [],
		modelCount: Object.keys(next).length,
		hadCache,
		previous,
		next,
	}
}

function cachedContextWindow(fullId: string): number | undefined {
	const bare = fullId.includes('/') ? fullId.slice(fullId.indexOf('/') + 1) : fullId
	const cached = loadModelsDevCache()
	return cached[bare] ?? cached[fullId]
}

function subscriptionContextWindow(fullId: string): number | undefined {
	const bare = fullId.includes('/') ? fullId.slice(fullId.indexOf('/') + 1) : fullId
	const capped = bare === 'gpt-5.5' || /^gpt-\d+\.\d+-(sol|terra|luna)$/.test(bare)
	if (!capped) return undefined
	const credential = auth.getCredential('openai')
	if (credential?.type !== 'token') return undefined
	// ChatGPT/Codex-backed OAuth uses the product limit: 400k total
	// window = 272k input + 128k reserved output, not the 1.05M API cap.
	return 272_000
}

function contextWindow(fullId: string): number {
	const subscription = subscriptionContextWindow(fullId)
	if (subscription) return subscription
	const cached = cachedContextWindow(fullId)
	if (cached) return cached
	return models.fallbackContextWindow(fullId)
}

export const serverModels = {
	state,
	init,
	loadModelsDevCache,
	cachedModelMetadata,
	hasConfiguredDirectSource,
	refreshModels,
	providerInfo,
	cachedContextWindow,
	contextWindow,
}
