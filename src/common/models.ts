// Model registry — aliases, display names, pricing, context windows.
import type { PartialTokenUsage } from './protocol.ts'
//
// Models are identified as "provider/model-id" (e.g. "anthropic/claude-opus-4-6").
// Short aliases like "opus" resolve to full IDs. Display names are extracted
// from model IDs via regex patterns for human-readable UI.

// ── Curated model catalog ──

type TrackFamily = 'opus' | 'sonnet' | 'haiku' | 'fable' | 'sol' | 'terra' | 'luna' | 'codex' | 'gemini' | 'gemini-pro' | 'grok'

interface CatalogEntry {
	group: 'HAL' | 'Anthropic' | 'OpenAI' | 'Google' | 'OpenRouter'
	alias: string
	aliases?: string[]
	fullId: string
	fallbackContext?: number
	pricing?: { input: number; output: number }
	track?: TrackFamily
}

const CATALOG: CatalogEntry[] = [
	{ group: 'HAL', alias: 'intro', fullId: 'hal/intro', fallbackContext: 1_000_000 },
	{ group: 'HAL', alias: 'scroll', fullId: 'hal/scroll', fallbackContext: 1_000_000 },
	{ group: 'Anthropic', alias: 'opus', aliases: ['anthropic', 'claude'], fullId: 'anthropic/claude-opus-5', fallbackContext: 1_000_000, pricing: { input: 5, output: 25 }, track: 'opus' },
	{ group: 'Anthropic', alias: 'sonnet', fullId: 'anthropic/claude-sonnet-5', fallbackContext: 1_000_000, pricing: { input: 3, output: 15 }, track: 'sonnet' },
	{ group: 'Anthropic', alias: 'haiku', fullId: 'anthropic/claude-haiku-4-5', fallbackContext: 200_000, pricing: { input: 1, output: 5 }, track: 'haiku' },
	{ group: 'Anthropic', alias: 'fable', fullId: 'anthropic/claude-fable-5-1', fallbackContext: 1_000_000, pricing: { input: 10, output: 50 }, track: 'fable' },
	// GPT tiers since 5.6: sol = flagship, terra = everyday/default, luna = fast+cheap.
	// The plain-numbered gpt-X.Y line ended at 5.5; "gpt" tracks the terra tier.
	{ group: 'OpenAI', alias: 'gpt', aliases: ['openai', 'terra'], fullId: 'openai/gpt-5.6-terra', fallbackContext: 1_050_000, pricing: { input: 2.5, output: 15 }, track: 'terra' },
	{ group: 'OpenAI', alias: 'sol', fullId: 'openai/gpt-5.6-sol', fallbackContext: 1_050_000, pricing: { input: 5, output: 30 }, track: 'sol' },
	{ group: 'OpenAI', alias: 'luna', fullId: 'openai/gpt-5.6-luna', fallbackContext: 1_050_000, pricing: { input: 1, output: 6 }, track: 'luna' },
	{ group: 'OpenAI', alias: 'gpt-5.5', fullId: 'openai/gpt-5.5', fallbackContext: 1_050_000 },
	{ group: 'OpenAI', alias: 'gpt-5.4', fullId: 'openai/gpt-5.4', fallbackContext: 1_050_000 },
	{ group: 'OpenAI', alias: 'gpt-5.6', fullId: 'openai/gpt-5.6', fallbackContext: 1_050_000 },
	{ group: 'OpenAI', alias: 'gpt-instant', fullId: 'openai/gpt-5.5-instant', fallbackContext: 400_000, pricing: { input: 5, output: 30 } },
	{ group: 'OpenAI', alias: 'codex', fullId: 'openai/gpt-5.3-codex', fallbackContext: 128_000, track: 'codex' },
	{ group: 'Google', alias: 'gemini', fullId: 'google/gemini-3.7-flash', fallbackContext: 1_000_000, track: 'gemini' },
	{ group: 'Google', alias: 'gemini-3.5-flash-lite', fullId: 'google/gemini-3.5-flash-lite', fallbackContext: 1_000_000 },
	{ group: 'Google', alias: 'gemini-pro', fullId: 'google/gemini-3.1-pro-preview', fallbackContext: 1_000_000, track: 'gemini-pro' },
	{ group: 'OpenRouter', alias: 'grok', fullId: 'openrouter/x-ai/grok-4.6', fallbackContext: 2_000_000, track: 'grok' },
	{ group: 'OpenRouter', alias: 'deepseek', fullId: 'openrouter/deepseek/deepseek-v3.2' },
	{ group: 'OpenRouter', alias: 'deepseek-4', fullId: 'openrouter/deepseek/deepseek-v4-pro', fallbackContext: 1_000_000 },
	{ group: 'OpenRouter', alias: 'llama', fullId: 'openrouter/meta-llama/llama-4-maverick' },
	{ group: 'OpenRouter', alias: 'qwen', fullId: 'openrouter/qwen/qwen3.8-max' },
	{ group: 'OpenRouter', alias: 'qwen-coder', fullId: 'openrouter/qwen/qwen3-coder', fallbackContext: 1_000_000 },
	{ group: 'OpenRouter', alias: 'kimi', fullId: 'openrouter/moonshotai/kimi-k3', fallbackContext: 1_000_000 },
	{ group: 'OpenRouter', alias: 'glm', fullId: 'openrouter/z-ai/glm-5.2', fallbackContext: 1_000_000 },
	{ group: 'OpenRouter', alias: 'minimax', fullId: 'openrouter/minimax/minimax-m3', fallbackContext: 1_000_000 },
	{ group: 'OpenRouter', alias: 'mistral', fullId: 'openrouter/mistralai/mistral-large-2512', fallbackContext: 262_144 },
]

// Pattern-based alias: opus-X → anthropic/claude-opus-X, etc.
const PATTERNS: [RegExp, string][] = [
	[/^opus-(.+)$/, 'anthropic/claude-opus-$1'],
	[/^sonnet-(.+)$/, 'anthropic/claude-sonnet-$1'],
	[/^haiku-(.+)$/, 'anthropic/claude-haiku-$1'],
	[/^fable-(.+)$/, 'anthropic/claude-fable-$1'],
	[/^gpt-?(\d+\.\d+(?:-[a-z0-9.-]+)?)$/, 'openai/gpt-$1'],
	[/^gemini-(.+)$/, 'google/gemini-$1'],
	[/^grok-(.+)$/, 'openrouter/x-ai/grok-$1'],
]

// Providers with their own Hal backend, so "vendor/model" is already routable.
const DIRECT_PROVIDERS = ['hal', 'anthropic', 'openai', 'google', 'openrouter']

function resolveModel(input: string): string {
	// models.dev lists OpenRouter models as "vendor/model"; Hal routes them as "openrouter/vendor/model".
	// Vendors Hal talks to directly keep their own ids — models.dev also resells those through OpenRouter.
	if (input.includes('/')) {
		const vendor = input.slice(0, input.indexOf('/'))
		if (DIRECT_PROVIDERS.includes(vendor) || !state.openrouterIds.includes(input)) return input
		return `openrouter/${input}`
	}
	const alias = aliasFullId(input)
	if (alias) return alias
	for (const [re, replacement] of PATTERNS) {
		if (re.test(input)) return input.replace(re, replacement)
	}
	// "glm-5.3" → "openrouter/z-ai/glm-5.3". Vendor prefixes are noise when the model
	// name is unambiguous; openrouterIds is newest-first, so the first match wins.
	const bare = state.openrouterIds.find((id) => id.endsWith(`/${input}`))
	return cachedNativeFullId(input) ?? (bare ? `openrouter/${bare}` : input)
}

// ── Display names ──
// Regex patterns to extract human-readable names from model IDs.

function displayTitleSuffix(text: string): string {
	const words: string[] = []
	for (const part of text.split('-')) {
		words.push(part[0]!.toUpperCase() + part.slice(1))
	}
	return words.join(' ')
}

const DISPLAY_PATTERNS: [RegExp, (m: RegExpMatchArray) => string][] = [
	[/^intro$/, () => 'Intro'],
	[/^scroll$/, () => 'Scroll Test'],
	// claude-haiku-4-5-20251001 → Haiku 4.5
	[
		/^claude-(opus|sonnet|haiku|fable)-(\d+)-(\d+)-\d{8,}$/,
		(m) => {
			const tier = m[1]![0]!.toUpperCase() + m[1]!.slice(1)
			return `${tier} ${m[2]}.${m[3]}`
		},
	],
	// claude-opus-4-6 → Opus 4.6
	[
		/^claude-(opus|sonnet|haiku|fable)-(\d+)-(\d{1,2})$/,
		(m) => {
			const tier = m[1]![0]!.toUpperCase() + m[1]!.slice(1)
			return `${tier} ${m[2]}.${m[3]}`
		},
	],
	// claude-sonnet-4-20250514 → Sonnet 4
	[
		/^claude-(opus|sonnet|haiku|fable)-(\d+)-\d{8,}$/,
		(m) => {
			const tier = m[1]![0]!.toUpperCase() + m[1]!.slice(1)
			return `${tier} ${m[2]}`
		},
	],
	// claude-fable-5 → Fable 5
	[
		/^claude-(opus|sonnet|haiku|fable)-(\d+)$/,
		(m) => {
			const tier = m[1]![0]!.toUpperCase() + m[1]!.slice(1)
			return `${tier} ${m[2]}`
		},
	],
	// gpt-5.3-codex → Codex 5.3
	[/^gpt-(\d+\.\d+)-codex$/, (m) => `Codex ${m[1]}`],
	// gpt-5.5-instant → GPT 5.5 Instant
	[/^gpt-(\d+\.\d+)-([a-z0-9.-]+)$/, (m) => `GPT ${m[1]} ${displayTitleSuffix(m[2]!)}`],
	// gpt-5.4 → GPT 5.4
	[/^gpt-(\d+\.\d+)$/, (m) => `GPT ${m[1]}`],
	// x-ai/grok-4.6 → Grok 4.6
	[/^(?:x-ai\/)?grok-((?:\d+\.)*\d+)$/, (m) => `Grok ${m[1]}`],
]

function displayModel(fullId: string | undefined): string {
	if (!fullId) return ''
	const modelId = fullId.includes('/') ? fullId.slice(fullId.indexOf('/') + 1) : fullId
	for (const [re, fmt] of DISPLAY_PATTERNS) {
		const m = modelId.match(re)
		if (m) return fmt(m)
	}
	return modelId
}

function reasoningEffort(fullId: string | undefined): string {
	if (!fullId) return ''
	const modelId = fullId.includes('/') ? fullId.slice(fullId.indexOf('/') + 1) : fullId
	if (modelId.includes('codex')) return 'xhigh'
	if (/^o\d/.test(modelId) || /^gpt-5\./.test(modelId)) return 'high'
	return ''
}

// Discovered context data is hydrated by the host. Keeping this registry free of
// I/O lets terminal and browser clients share the same Hal model-domain logic.
const DEFAULT_CONTEXT = 200_000

const state = {
	cache: null as Record<string, number> | null,
	// Every OpenRouter model id known to models.dev ("vendor/model"), newest first.
	openrouterIds: [] as string[],
}

function modelCache(): Record<string, number> {
	return state.cache ?? {}
}

function hydrate(cache: Record<string, number>, openrouterIds: string[] = []): void {
	state.cache = cache
	state.openrouterIds = openrouterIds
}

interface FrontierModelInfo {
	kind: 'gpt' | 'claude'
	family: string
	version: number[]
}

interface AliasUpdateSuggestion {
	aliases: string[]
	oldModel: string
	newModel: string
}

interface ModelDiscovery {
	provider: 'Anthropic' | 'OpenAI' | 'Google'
	model: string
	context: number
}

interface ModelCandidate {
	canonical: string
	version: number[]
	stability: number
}

function formatContext(n: number): string {
	return `${Math.round(n / 1000)}k`
}

function isRelevantModelId(id: string): boolean {
	if (/(^|\/)gpt-[a-z0-9.-]+/.test(id)) return true
	if (/(^|\/)o\d[a-z0-9.-]*/.test(id)) return true
	if (/(^|\/)codex-[a-z0-9.-]+/.test(id)) return true
	if (/(^|\/)claude-[a-z0-9-]+/.test(id)) return true
	return false
}

function discoveryModelInfo(id: string): { provider: ModelDiscovery['provider']; model: string } | null {
	let text = id.startsWith('~') ? id.slice(1) : id
	if (text.startsWith('anthropic/')) text = text.slice('anthropic/'.length)
	else if (text.startsWith('openai/')) text = text.slice('openai/'.length)
	else if (text.startsWith('google/')) text = text.slice('google/'.length)
	else if (text.includes('/')) return null
	if (text.includes('latest')) return null
	if (/^claude-[a-z0-9-]+$/.test(text)) return { provider: 'Anthropic', model: text }
	if (/^(gpt-[a-z0-9.-]+|o\d[a-z0-9.-]*|codex-[a-z0-9.-]+)$/.test(text)) return { provider: 'OpenAI', model: text }
	if (/^gemini-[a-z0-9.-]+$/.test(text)) return { provider: 'Google', model: text }
	return null
}

function modelDiscoveries(previous: Record<string, number>, next: Record<string, number>): ModelDiscovery[] {
	const old = new Set<string>()
	for (const id of Object.keys(previous)) {
		const info = discoveryModelInfo(id)
		if (info) old.add(`${info.provider}/${info.model}`)
	}
	const found = new Map<string, ModelDiscovery>()
	for (const [id, context] of Object.entries(next)) {
		const info = discoveryModelInfo(id)
		if (!info) continue
		const key = `${info.provider}/${info.model}`
		if (old.has(key)) continue
		const existing = found.get(key)
		if (!existing || context > existing.context) found.set(key, { ...info, context })
	}
	return [...found.values()].sort((a, b) => `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`))
}

function modelFamilyLabel(id: string): string {
	if (/(^|\/)gpt-[a-z0-9.-]+/.test(id)) return 'GPT'
	if (/(^|\/)(o\d|codex-)/.test(id)) return 'OpenAI'
	return 'Claude'
}

function parseVersionParts(text: string): number[] {
	return text.split('.').map((part) => Number(part))
}

function frontierModelInfo(fullId: string): FrontierModelInfo | null {
	const id = fullId.includes('/') ? fullId.slice(fullId.indexOf('/') + 1) : fullId
	const gpt = id.match(/^gpt-(\d+)\.(\d+)$/)
	if (gpt) return { kind: 'gpt', family: `GPT ${gpt[1]}`, version: [Number(gpt[1]), Number(gpt[2])] }

	const claude = id.match(/^claude-(opus|sonnet|haiku|fable)-(\d+)(?:[.-](\d+)|-\d{8,})?$/)
	if (!claude) return null
	const tier = claude[1]![0]!.toUpperCase() + claude[1]!.slice(1)
	return { kind: 'claude', family: `${tier} ${claude[2]}`, version: [Number(claude[2]), Number(claude[3] ?? 0)] }
}

function compareVersions(a: number[], b: number[]): number {
	const len = Math.max(a.length, b.length)
	for (let i = 0; i < len; i++) {
		const diff = (a[i] ?? 0) - (b[i] ?? 0)
		if (diff !== 0) return diff
	}
	return 0
}

function compareCandidates(a: ModelCandidate, b: ModelCandidate): number {
	const versionDiff = compareVersions(a.version, b.version)
	if (versionDiff !== 0) return versionDiff
	const stabilityDiff = a.stability - b.stability
	if (stabilityDiff !== 0) return stabilityDiff
	return a.canonical.localeCompare(b.canonical)
}

function providerPrefix(fullId: string): string {
	const idx = fullId.indexOf('/')
	return idx >= 0 ? fullId.slice(0, idx + 1) : ''
}

function newestModelInFamily(cache: Record<string, number>, family: string): string | null {
	let bestId: string | null = null
	let bestInfo: FrontierModelInfo | null = null
	for (const id of Object.keys(cache)) {
		const info = frontierModelInfo(id)
		if (!info || info.family !== family) continue
		if (!bestInfo || compareVersions(info.version, bestInfo.version) > 0) {
			bestId = id
			bestInfo = info
		}
	}
	return bestId
}

function parseClaudeCandidate(tier: 'opus' | 'sonnet' | 'haiku' | 'fable', modelId: string): ModelCandidate | null {
	const match = modelId.match(new RegExp(`^claude-${tier}-(\\d+)(?:-(\\d{8,})|[.-](\\d+))?$`))
	if (!match) return null
	const major = Number(match[1])
	const minor = Number(match[3] ?? 0)
	const canonical = minor > 0 ? `claude-${tier}-${major}-${minor}` : `claude-${tier}-${major}`
	return { canonical, version: [major, minor], stability: match[3] ? 2 : match[2] ? 0 : 1 }
}

function parseGptCandidate(modelId: string): ModelCandidate | null {
	const match = modelId.match(/^gpt-(\d+)\.(\d+)$/)
	if (!match) return null
	return {
		canonical: `gpt-${match[1]}.${match[2]}`,
		version: [Number(match[1]), Number(match[2])],
		stability: 1,
	}
}

// GPT tier IDs like gpt-5.6-terra. Excludes -pro variants (API/Pro-plan only,
// rejected by the ChatGPT subscription backend).
function parseGptTierCandidate(tier: 'sol' | 'terra' | 'luna', modelId: string): ModelCandidate | null {
	const match = modelId.match(new RegExp(`^gpt-(\\d+)\\.(\\d+)-${tier}$`))
	if (!match) return null
	return {
		canonical: `gpt-${match[1]}.${match[2]}-${tier}`,
		version: [Number(match[1]), Number(match[2])],
		stability: 1,
	}
}

function parseCodexCandidate(modelId: string): ModelCandidate | null {
	const match = modelId.match(/^gpt-(\d+)\.(\d+)-codex$/)
	if (!match) return null
	return {
		canonical: `gpt-${match[1]}.${match[2]}-codex`,
		version: [Number(match[1]), Number(match[2])],
		stability: 1,
	}
}

function parseGeminiCandidate(kind: 'flash' | 'pro', modelId: string): ModelCandidate | null {
	const match = modelId.match(new RegExp(`^gemini-((?:\\d+\\.)*\\d+)-${kind}(-preview)?$`))
	if (!match) return null
	return {
		canonical: `gemini-${match[1]}-${kind}${match[2] ?? ''}`,
		version: parseVersionParts(match[1]!),
		stability: match[2] ? 0 : 1,
	}
}

function parseGrokVersion(text: string): number[] {
	const parts = text.split('.')
	// 4.20/4.21 are 4.2.x marketing ids, not minor version 20/21.
	if (parts.length === 2 && /^2\d$/.test(parts[1]!)) {
		return [Number(parts[0]), 2, Number(parts[1]!.slice(1))]
	}
	return parseVersionParts(text)
}

function parseGrokCandidate(modelId: string): ModelCandidate | null {
	const match = modelId.match(/^(?:(?:openrouter\/)?(?:x-ai|xai)\/)?grok-((?:\d+\.)*\d+)(-fast)?$/)
	if (!match) return null
	return {
		canonical: `x-ai/grok-${match[1]}${match[2] ?? ''}`,
		version: parseGrokVersion(match[1]!),
		stability: match[2] ? 0 : 1,
	}
}

function newestMatchingModel(cache: Record<string, number>, parse: (modelId: string) => ModelCandidate | null): string | null {
	let best: ModelCandidate | null = null
	for (const fullId of Object.keys(cache)) {
		const stripped = fullId.includes('/') ? fullId.slice(fullId.indexOf('/') + 1) : fullId
		const candidate = parse(fullId) ?? parse(stripped)
		if (!candidate) continue
		if (!best || compareCandidates(candidate, best) > 0) best = candidate
	}
	return best?.canonical ?? null
}

function providerId(provider: ModelDiscovery['provider']): string {
	if (provider === 'Anthropic') return 'anthropic'
	if (provider === 'Google') return 'google'
	return 'openai'
}

function catalogAliases(entry: CatalogEntry): string[] {
	return [...(entry.aliases ?? []), entry.alias]
}


function aliasesForModel(fullId: string): string[] {
	for (const entry of CATALOG) {
		if (entry.fullId === fullId) return catalogAliases(entry)
	}
	return []
}

function catalogEntryForAlias(alias: string): CatalogEntry | undefined {
	return CATALOG.find((entry) => catalogAliases(entry).includes(alias))
}

function latestTrackedModel(track: TrackFamily, cache: Record<string, number>): string | null {
	if (track === 'opus' || track === 'sonnet' || track === 'haiku' || track === 'fable') return newestMatchingModel(cache, (id) => parseClaudeCandidate(track, id))
	if (track === 'sol' || track === 'terra' || track === 'luna') return newestMatchingModel(cache, (id) => parseGptTierCandidate(track, id))
	if (track === 'codex') return newestMatchingModel(cache, parseCodexCandidate)
	if (track === 'gemini') return newestMatchingModel(cache, (id) => parseGeminiCandidate('flash', id))
	if (track === 'gemini-pro') return newestMatchingModel(cache, (id) => parseGeminiCandidate('pro', id))
	return newestMatchingModel(cache, parseGrokCandidate)
}

function candidateForTrack(track: TrackFamily, fullId: string): ModelCandidate | null {
	const stripped = fullId.includes('/') ? fullId.slice(fullId.indexOf('/') + 1) : fullId
	if (track === 'opus' || track === 'sonnet' || track === 'haiku' || track === 'fable') return parseClaudeCandidate(track, stripped)
	if (track === 'sol' || track === 'terra' || track === 'luna') return parseGptTierCandidate(track, stripped)
	if (track === 'codex') return parseCodexCandidate(stripped)
	if (track === 'gemini') return parseGeminiCandidate('flash', stripped)
	if (track === 'gemini-pro') return parseGeminiCandidate('pro', stripped)
	return parseGrokCandidate(fullId) ?? parseGrokCandidate(stripped)
}

function latestCatalogFullId(entry: CatalogEntry, cache: Record<string, number>): string {
	if (!entry.track) return entry.fullId
	const latestModelId = latestTrackedModel(entry.track, cache)
	if (!latestModelId) return entry.fullId
	const catalogCandidate = candidateForTrack(entry.track, entry.fullId)
	const latestCandidate = candidateForTrack(entry.track, latestModelId)
	if (catalogCandidate && latestCandidate && compareCandidates(latestCandidate, catalogCandidate) <= 0) return entry.fullId
	return `${providerPrefix(entry.fullId)}${latestModelId}`
}

function aliasFullId(alias: string): string | null {
	const entry = catalogEntryForAlias(alias)
	if (!entry) return null
	return latestCatalogFullId(entry, modelCache())
}

function cachedNativeFullId(modelId: string): string | null {
	for (const id of Object.keys(modelCache())) {
		const info = discoveryModelInfo(id)
		if (!info || info.model !== modelId) continue
		return `${providerId(info.provider)}/${info.model}`
	}
	return null
}

function aliasUpdateSuggestions(previous: Record<string, number>, next: Record<string, number>): AliasUpdateSuggestion[] {
	const updates: AliasUpdateSuggestion[] = []
	for (const entry of CATALOG) {
		if (!entry.track) continue
		const previousModel = latestCatalogFullId(entry, previous)
		const newModel = latestCatalogFullId(entry, next)
		if (previousModel === newModel) continue
		if (newModel === entry.fullId) continue
		updates.push({ aliases: catalogAliases(entry), oldModel: entry.fullId, newModel })
	}
	return updates
}

function modelChangeMessages(previous: Record<string, number>, next: Record<string, number>): string[] {
	const changes: string[] = []
	for (const [id, context] of Object.entries(next).sort(([a], [b]) => a.localeCompare(b))) {
		if (!isRelevantModelId(id)) continue
		const before = previous[id]
		if (before == null) {
			const family = modelFamilyLabel(id)
			changes.push(`new ${family} model ${id} (${formatContext(context)})`)
		} else if (before !== context) {
			changes.push(`${id} context ${formatContext(before)} → ${formatContext(context)}`)
		}
	}
	return changes
}


// ── Pricing (USD per million tokens) ──

// Prompt-cache reads bill at 10% for the priced Anthropic/OpenAI models here.
// Anthropic writes bill at 125%.
// https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching#pricing
const CACHE_READ_MULTIPLIER = 0.1
const CACHE_WRITE_MULTIPLIER = 1.25

function fallbackContextWindow(fullId: string): number {
	for (const entry of CATALOG) {
		if (entry.fullId === fullId && entry.fallbackContext) return entry.fallbackContext
	}
	return DEFAULT_CONTEXT
}

function computeCost(
	fullId: string,
	usage: PartialTokenUsage,
): number {
	const p = CATALOG.find((entry) => entry.fullId === fullId)?.pricing
	if (!p) return 0
	const cacheReadCost = (usage.cacheRead ?? 0) * p.input * CACHE_READ_MULTIPLIER
	const cacheWriteCost = (usage.cacheCreation ?? 0) * p.input * CACHE_WRITE_MULTIPLIER
	return (usage.input * p.input + usage.output * p.output + cacheReadCost + cacheWriteCost) / 1_000_000
}

function formatCost(
	fullId: string,
	usage: PartialTokenUsage,
): string {
	const cost = computeCost(fullId, usage)
	if (cost === 0) return ''
	return `$${cost.toFixed(4)}`
}

// ── Default model ──

const config = {
	// Default model alias or full ID. Set via config.ason under "models".
	// 'gpt' tracks the newest GPT everyday tier (currently openai/gpt-5.6-terra).
	default: 'gpt',
}

function defaultModel(): string {
	return resolveModel(config.default)
}

// ── Model listing (for /model command) ──

interface ModelEntry {
	alias: string
	fullId: string
	static: boolean
}

interface ModelChoice {
	value: string
	label: string
	search: string
	path: string[]
	leafLabel: string
	display: string
	fullId: string
}

function catalogGroups(): CatalogEntry['group'][] {
	return [...new Set(CATALOG.map((entry) => entry.group))]
}

function groupModelEntries(group: CatalogEntry['group']): ModelEntry[] {
	const entries: ModelEntry[] = []
	const seen = new Set<string>()
	for (const entry of CATALOG) {
		if (entry.group !== group) continue
		const fullId = aliasFullId(entry.alias) ?? entry.fullId
		entries.push({ alias: entry.alias, fullId, static: true })
		seen.add(fullId)
	}
	if (group !== 'Anthropic' && group !== 'OpenAI') return entries
	for (const id of Object.keys(modelCache()).sort()) {
		const info = discoveryModelInfo(id)
		if (!info || info.provider !== group) continue
		const fullId = `${providerId(info.provider)}/${info.model}`
		if (seen.has(fullId)) continue
		seen.add(fullId)
		entries.push({ alias: info.model, fullId, static: false })
	}
	return entries
}

function addModelCompletionNames(names: Set<string>, model: ModelEntry): void {
	names.add(model.alias)
	names.add(model.fullId)
	const slash = model.fullId.indexOf('/')
	if (slash >= 0) names.add(model.fullId.slice(slash + 1))
	if (!model.static) return
	const anthropic = model.fullId.match(/^anthropic\/claude-(opus|sonnet|haiku|fable)-(.+)$/)
	if (anthropic) names.add(`${anthropic[1]}-${anthropic[2]}`)
}

function allKnownModelIds(): string[] {
	const ids = new Set<string>()
	for (const entry of CATALOG) ids.add(entry.fullId)
	for (const id of Object.keys(modelCache())) {
		const info = discoveryModelInfo(id)
		if (!info) continue
		ids.add(`${providerId(info.provider)}/${info.model}`)
	}
	return [...ids]
}

function bareModelId(fullId: string): string {
	return fullId.includes('/') ? fullId.slice(fullId.indexOf('/') + 1) : fullId
}

function curatedCandidates(parse: (modelId: string) => ModelCandidate | null, minMajor: number): ModelCandidate[] {
	const best = new Map<string, ModelCandidate>()
	for (const fullId of allKnownModelIds()) {
		const candidate = parse(bareModelId(fullId))
		if (!candidate) continue
		if ((candidate.version[0] ?? 0) < minMajor) continue
		const existing = best.get(candidate.canonical)
		if (!existing || compareCandidates(candidate, existing) > 0) best.set(candidate.canonical, candidate)
	}
	return [...best.values()].sort((a, b) => compareCandidates(b, a))
}

function modelChoiceLabel(value: string, display: string, fullId: string): string {
	return `${value.padEnd(18)} ${display} · ${fullId}`
}

function addModelChoice(items: ModelChoice[], value: string, fullId: string, path: string[], leafLabel: string): void {
	const display = displayModel(fullId)
	items.push({
		value,
		label: modelChoiceLabel(value, display, fullId),
		search: `${path.join(' ')} ${leafLabel} ${value} ${fullId} ${display}`.toLowerCase(),
		path,
		leafLabel,
		display,
		fullId,
	})
}

function versionLeaf(version: number[], forceMinor: boolean): string {
	const major = version[0] ?? 0
	const minor = version[1] ?? 0
	if (forceMinor || minor > 0) return `${major}.${minor}`
	return String(major)
}

function anthropicChoiceValue(tier: 'opus' | 'sonnet' | 'haiku' | 'fable', fullId: string, canonical: string): string {
	if (aliasFullId(tier) === fullId) return tier
	return `${tier}-${canonical.slice(`claude-${tier}-`.length)}`
}

function addAnthropicChoices(items: ModelChoice[]): void {
	const tiers: Array<{ tier: 'fable' | 'opus' | 'sonnet' | 'haiku'; minMajor: number }> = [
		{ tier: 'fable', minMajor: 5 },
		{ tier: 'opus', minMajor: 4 },
		{ tier: 'sonnet', minMajor: 4 },
		{ tier: 'haiku', minMajor: 4 },
	]
	for (const { tier, minMajor } of tiers) {
		const candidates = curatedCandidates((id) => parseClaudeCandidate(tier, id), minMajor)
		for (const candidate of candidates) {
			const fullId = `anthropic/${candidate.canonical}`
			const value = anthropicChoiceValue(tier, fullId, candidate.canonical)
			addModelChoice(items, value, fullId, ['anthropic', tier], versionLeaf(candidate.version, tier !== 'fable'))
		}
	}
}

function addOpenAiChoices(items: ModelChoice[]): void {
	const choices: Array<{ candidate: ModelCandidate; suffix: string; value: string; fullId: string }> = []
	for (const candidate of curatedCandidates(parseGptCandidate, 5)) {
		const fullId = `openai/${candidate.canonical}`
		choices.push({ candidate, suffix: versionLeaf(candidate.version, true), value: aliasFullId('gpt') === fullId ? 'gpt' : candidate.canonical, fullId })
	}
	for (const tier of ['sol', 'terra', 'luna'] as const) {
		for (const candidate of curatedCandidates((id) => parseGptTierCandidate(tier, id), 5)) {
			const fullId = `openai/${candidate.canonical}`
			// terra is the "gpt" default alias; sol/luna use their own tier aliases.
			const alias = tier === 'terra' ? 'gpt' : tier
			const value = aliasFullId(alias) === fullId ? alias : candidate.canonical
			choices.push({ candidate, suffix: `${versionLeaf(candidate.version, true)}-${tier}`, value, fullId })
		}
	}
	for (const candidate of curatedCandidates(parseCodexCandidate, 5)) {
		const fullId = `openai/${candidate.canonical}`
		choices.push({ candidate, suffix: `${versionLeaf(candidate.version, true)}-codex`, value: aliasFullId('codex') === fullId ? 'codex' : candidate.canonical, fullId })
	}
	choices.sort((a, b) => compareCandidates(b.candidate, a.candidate))
	for (const choice of choices) addModelChoice(items, choice.value, choice.fullId, ['openai', 'gpt'], choice.suffix)
	const instant = catalogEntryForAlias('gpt-instant')!
	addModelChoice(items, instant.alias, aliasFullId(instant.alias) ?? instant.fullId, ['openai', 'gpt'], instant.alias)
}

function addStaticProviderChoices(items: ModelChoice[], group: CatalogEntry['group'], providerPath: string): void {
	for (const entry of CATALOG) {
		if (entry.group !== group) continue
		const fullId = aliasFullId(entry.alias) ?? entry.fullId
		addModelChoice(items, entry.alias, fullId, [providerPath], entry.alias)
	}
}

// OpenRouter models are whatever models.dev knows about, grouped by vendor.
// A catalog alias (grok, qwen, …) replaces the value of the model it points at,
// so every model is listed exactly once and aliases stay typeable.
function addOpenRouterChoices(items: ModelChoice[]): void {
	const aliases = new Map<string, string>()
	for (const entry of CATALOG) {
		if (entry.group !== 'OpenRouter') continue
		const fullId = aliasFullId(entry.alias) ?? entry.fullId
		aliases.set(fullId.slice('openrouter/'.length), entry.alias)
	}
	const seen = new Set<string>()
	// Catalog ids first so aliased models are listed even before /check fetches models.dev.
	for (const id of [...aliases.keys(), ...state.openrouterIds]) {
		if (seen.has(id)) continue
		seen.add(id)
		const slash = id.indexOf('/')
		// Resold Anthropic/OpenAI/Google models already have their own picker sections.
		if (slash < 0 || DIRECT_PROVIDERS.includes(id.slice(0, slash))) continue
		addModelChoice(items, aliases.get(id) ?? id, `openrouter/${id}`, ['openrouter', id.slice(0, slash)], id.slice(slash + 1))
	}
}

function listModels(): string[] {
	const lines: string[] = []
	for (const group of catalogGroups()) {
		lines.push(group)
		for (const m of groupModelEntries(group)) {
			lines.push(`  ${m.alias.padEnd(14)} ${m.fullId}`)
		}
		lines.push('')
	}
	lines.push('Patterns: opus-X, sonnet-X, haiku-X, fable-X, gpt-X.Y[-suffix], gemini-X, grok-X')
	return lines
}

function listModelChoices(): ModelChoice[] {
	const items: ModelChoice[] = []
	addStaticProviderChoices(items, 'HAL', 'hal')
	addOpenAiChoices(items)
	addAnthropicChoices(items)
	addStaticProviderChoices(items, 'Google', 'google')
	addOpenRouterChoices(items)
	return items
}

function modelCompletionNames(): string[] {
	const names = new Set<string>()
	for (const group of catalogGroups()) {
		for (const model of groupModelEntries(group)) {
			addModelCompletionNames(names, model)
		}
	}
	// Every OpenRouter model completes bare ("glm-5.3"), with vendor, and fully prefixed.
	for (const id of state.openrouterIds) {
		names.add(id.slice(id.indexOf('/') + 1))
		names.add(id)
		names.add(`openrouter/${id}`)
	}
	return [...names].sort()
}

// ── Token estimation ──
// Rough estimate: ~4 chars per token for English text.
// This is only for UI display — real token counts come from provider responses.

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4)
}


// Format a token count for display: "25.4k" or "200k"
function formatTokenCount(n: number): string {
	if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`
	return String(n)
}

// Extract provider name from a full model ID ("anthropic/claude-opus-4-6" → "anthropic")
function providerName(fullId: string): string {
	const idx = fullId.indexOf('/')
	return idx >= 0 ? fullId.slice(0, idx) : fullId
}

export const models = {
	state,
	config,
	hydrate,
	resolveModel,
	displayModel,
	reasoningEffort,
	fallbackContextWindow,
	aliasesForModel,
	computeCost,
	formatCost,
	formatTokenCount,
	providerName,
	defaultModel,
	listModels,
	listModelChoices,
	modelCompletionNames,
	estimateTokens,
	modelChangeMessages,
	aliasUpdateSuggestions,
	modelDiscoveries,
	frontierModelInfo,
}
