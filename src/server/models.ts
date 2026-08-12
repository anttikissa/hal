// Model metadata infrastructure: models.dev cache, refresh, credentials, and context limits.

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { auth } from '../auth.ts'
import { models } from '../common/models.ts'
import { STATE_DIR, ensureDir } from '../state.ts'
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

interface ModelsDevCache {
	version: 1
	models: Record<string, ModelMetadata>
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
}

function modelsFile(): string {
	return `${process.env.HAL_STATE_DIR ?? STATE_DIR}/models.ason`
}

function contextWindows(metadata: Record<string, ModelMetadata>): Record<string, number> {
	const contexts: Record<string, number> = {}
	for (const [id, model] of Object.entries(metadata)) contexts[id] = model.context
	return contexts
}

/** Load persisted discovery data and hydrate the runtime-neutral model registry. */
function loadModelsDevCache(): Record<string, number> {
	if (models.state.cache) return models.state.cache
	try {
		const parsed = ason.parse(readFileSync(modelsFile(), 'utf-8')) as unknown as ModelsDevCache
		state.metadata = parsed.models
		models.hydrate(contextWindows(parsed.models))
	} catch {
		models.hydrate({})
		state.metadata = {}
	}
	return models.state.cache!
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

function modelsDevMetadata(data: Record<string, { models?: Record<string, any> }>): Record<string, ModelMetadata> {
	const metadata: Record<string, ModelMetadata> = {}
	for (const [provider, catalog] of Object.entries(data)) {
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
			if (typeof raw.name === 'string') model.name = raw.name
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

async function refreshModels(): Promise<RefreshModelsResult> {
	const hadCache = existsSync(modelsFile())
	const previous = hadCache ? loadModelsDevCache() : {}
	const res = await fetch('https://models.dev/api.json', { signal: AbortSignal.timeout(10_000) })
	const data = (await res.json()) as Record<string, { models?: Record<string, any> }>
	const metadata = modelsDevMetadata(data)
	const next = contextWindows(metadata)
	ensureDir(process.env.HAL_STATE_DIR ?? STATE_DIR)
	const cache: ModelsDevCache = { version: 1, models: metadata }
	writeFileSync(modelsFile(), ason.stringify(cache) + '\n')
	models.hydrate(next)
	state.metadata = metadata
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
	cachedContextWindow,
	contextWindow,
}
