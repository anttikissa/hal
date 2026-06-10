// Model registry — aliases, display names, pricing, context windows.
import type { PartialTokenUsage } from './protocol.ts'
import { auth } from './auth.ts'
//
// Models are identified as "provider/model-id" (e.g. "anthropic/claude-opus-4-6").
// Short aliases like "opus" resolve to full IDs. Display names are extracted
// from model IDs via regex patterns for human-readable UI.

// ── Aliases ──
// Short name → full provider/model-id

const ALIASES: Record<string, string> = {
	anthropic: 'anthropic/claude-opus-4-7',
	claude: 'anthropic/claude-opus-4-7',
	opus: 'anthropic/claude-opus-4-7',
	sonnet: 'anthropic/claude-sonnet-4-6',
	haiku: 'anthropic/claude-haiku-4-5',
	fable: 'anthropic/claude-fable-5',
	openai: 'openai/gpt-5.5',
	gpt: 'openai/gpt-5.5',
	instant: 'openai/gpt-5.5-instant',
	codex: 'openai/gpt-5.3-codex',
	gemini: 'google/gemini-3.5-flash',
	'gemini-pro': 'google/gemini-3.1-pro-preview',
	grok: 'openrouter/x-ai/grok-4.20',
	deepseek: 'openrouter/deepseek/deepseek-chat',
	llama: 'openrouter/meta-llama/llama-4-maverick',
}

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

function resolveModel(input: string): string {
	if (input.includes('/')) return input
	const alias = aliasFullId(input)
	if (alias) return alias
	for (const [re, replacement] of PATTERNS) {
		if (re.test(input)) return input.replace(re, replacement)
	}
	return cachedNativeFullId(input) ?? input
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

// ── Context windows (tokens) ──
// Fetched from models.dev on startup and cached in state/models.ason.
// Falls back to hardcoded defaults if the file doesn't exist yet.

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { STATE_DIR, ensureDir } from './state.ts'
import { ason } from './utils/ason.ts'

const DEFAULT_CONTEXT = 200_000
const state = {
	cache: null as Record<string, number> | null,
}

interface RefreshModelsResult {
	fetched: boolean
	changes: string[]
	modelCount: number
	hadCache: boolean
	previous: Record<string, number>
	next: Record<string, number>
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
	provider: 'Anthropic' | 'OpenAI'
	model: string
	context: number
}

interface ModelCandidate {
	canonical: string
	version: number[]
	stability: number
}

function modelsFile(): string {
	return `${process.env.HAL_STATE_DIR ?? STATE_DIR}/models.ason`
}

// Hardcoded fallbacks — used before first models.dev fetch completes
const FALLBACK_WINDOWS: Record<string, number> = {
	'anthropic/claude-opus-4-7': 1_000_000,
	'anthropic/claude-sonnet-4-6': 1_000_000,
	'anthropic/claude-haiku-4-5': 200_000,
	'anthropic/claude-fable-5': 1_000_000,
	'openai/gpt-5.5': 1_050_000,
	'openai/gpt-5.5-instant': 400_000,
	'openai/gpt-5.4': 1_050_000,
	'openai/gpt-5.3': 128_000,
	'openai/gpt-5.3-codex': 128_000,
	'google/gemini-3.5-flash': 1_000_000,
	'google/gemini-3.1-pro-preview': 1_000_000,
	'openrouter/x-ai/grok-4.20': 2_000_000,
}

// Lazy-loaded context window map from models.dev (state/models.ason).
// Keys are bare model IDs (without provider prefix), values are token counts.
function loadModelsDevCache(): Record<string, number> {
	if (state.cache) return state.cache
	try {
		state.cache = ason.parse(readFileSync(modelsFile(), 'utf-8')) as Record<string, number>
	} catch {
		state.cache = {}
	}
	return state.cache
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

function discoveryModelInfo(id: string): { provider: 'Anthropic' | 'OpenAI'; model: string } | null {
	let text = id.startsWith('~') ? id.slice(1) : id
	if (text.startsWith('anthropic/')) text = text.slice('anthropic/'.length)
	else if (text.startsWith('openai/')) text = text.slice('openai/'.length)
	else if (text.includes('/')) return null
	if (text.includes('latest')) return null
	if (/^claude-[a-z0-9-]+$/.test(text)) return { provider: 'Anthropic', model: text }
	if (/^(gpt-[a-z0-9.-]+|o\d[a-z0-9.-]*|codex-[a-z0-9.-]+)$/.test(text)) return { provider: 'OpenAI', model: text }
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

function parseGrokCandidate(modelId: string): ModelCandidate | null {
	const match = modelId.match(/^(x-ai|xai)\/grok-((?:\d+\.)*\d+)(-fast)?$/)
	if (!match) return null
	return {
		canonical: `x-ai/grok-${match[2]}${match[3] ?? ''}`,
		version: parseVersionParts(match[2]!),
		stability: match[3] ? 0 : 1,
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

const aliasUpdateGroups = [
	{ aliases: ['anthropic', 'claude', 'opus'], latest: (cache: Record<string, number>) => newestMatchingModel(cache, (id) => parseClaudeCandidate('opus', id)) },
	{ aliases: ['sonnet'], latest: (cache: Record<string, number>) => newestMatchingModel(cache, (id) => parseClaudeCandidate('sonnet', id)) },
	{ aliases: ['haiku'], latest: (cache: Record<string, number>) => newestMatchingModel(cache, (id) => parseClaudeCandidate('haiku', id)) },
	{ aliases: ['fable'], latest: (cache: Record<string, number>) => newestMatchingModel(cache, (id) => parseClaudeCandidate('fable', id)) },
	{ aliases: ['openai', 'gpt'], latest: (cache: Record<string, number>) => newestMatchingModel(cache, parseGptCandidate) },
	{ aliases: ['codex'], latest: (cache: Record<string, number>) => newestMatchingModel(cache, parseCodexCandidate) },
	{ aliases: ['gemini'], latest: (cache: Record<string, number>) => newestMatchingModel(cache, (id) => parseGeminiCandidate('flash', id)) },
	{ aliases: ['gemini-pro'], latest: (cache: Record<string, number>) => newestMatchingModel(cache, (id) => parseGeminiCandidate('pro', id)) },
	{ aliases: ['grok'], latest: (cache: Record<string, number>) => newestMatchingModel(cache, parseGrokCandidate) },
]

function providerId(provider: 'Anthropic' | 'OpenAI'): string {
	if (provider === 'Anthropic') return 'anthropic'
	return 'openai'
}

function aliasFullId(alias: string): string | null {
	const fallback = ALIASES[alias]
	if (!fallback) return null
	for (const group of aliasUpdateGroups) {
		if (!group.aliases.includes(alias)) continue
		const latest = group.latest(loadModelsDevCache())
		if (latest) return `${providerPrefix(fallback)}${latest}`
	}
	return fallback
}

function cachedNativeFullId(modelId: string): string | null {
	for (const id of Object.keys(loadModelsDevCache())) {
		const info = discoveryModelInfo(id)
		if (!info || info.model !== modelId) continue
		return `${providerId(info.provider)}/${info.model}`
	}
	return null
}

function aliasUpdateSuggestions(previous: Record<string, number>, next: Record<string, number>): AliasUpdateSuggestion[] {
	const updates: AliasUpdateSuggestion[] = []
	for (const group of aliasUpdateGroups) {
		const oldModel = ALIASES[group.aliases[0]!]!
		const nextModelId = group.latest(next)
		if (!nextModelId) continue
		const previousModelId = group.latest(previous)
		if (previousModelId === nextModelId) continue
		const newModel = `${providerPrefix(oldModel)}${nextModelId}`
		if (newModel === oldModel) continue
		updates.push({ aliases: group.aliases, oldModel, newModel })
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

/** Fetch context windows from models.dev and save to state/models.ason.
 *  Fire-and-forget on startup. The file persists across restarts. */
async function refreshModels(): Promise<RefreshModelsResult> {
	const hadCache = existsSync(modelsFile())
	const previous = hadCache ? loadModelsDevCache() : {}
	const res = await fetch('https://models.dev/api.json', { signal: AbortSignal.timeout(10_000) })
	const data = (await res.json()) as Record<string, { models?: Record<string, any> }>
	const ctx: Record<string, number> = {}
	for (const provider of Object.values(data)) {
		for (const [id, model] of Object.entries(provider.models ?? {})) {
			if (model.limit?.context) ctx[id] = model.limit.context
		}
	}
	ensureDir(process.env.HAL_STATE_DIR ?? STATE_DIR)
	writeFileSync(modelsFile(), ason.stringify(ctx) + '\n')
	state.cache = ctx
	return {
		fetched: true,
		changes: hadCache ? modelChangeMessages(previous, ctx) : [],
		modelCount: Object.keys(ctx).length,
		hadCache,
		previous,
		next: ctx,
	}
}

function cachedContextWindow(fullId: string): number | undefined {
	const bare = fullId.includes('/') ? fullId.slice(fullId.indexOf('/') + 1) : fullId
	const cached = loadModelsDevCache()
	return cached[bare] ?? cached[fullId]
}

function subscriptionContextWindow(fullId: string): number | undefined {
	if (fullId !== 'openai/gpt-5.5' && fullId !== 'gpt-5.5') return undefined
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
	if (FALLBACK_WINDOWS[fullId]) return FALLBACK_WINDOWS[fullId]
	return DEFAULT_CONTEXT
}

// ── Pricing (USD per million tokens) ──

const PRICING: Record<string, { input: number; output: number }> = {
	'anthropic/claude-opus-4-7': { input: 5, output: 25 },
	'anthropic/claude-sonnet-4-6': { input: 3, output: 15 },
	'anthropic/claude-haiku-4-5': { input: 1, output: 5 },
	'anthropic/claude-fable-5': { input: 10, output: 50 },
	'openai/gpt-5.5-instant': { input: 5, output: 30 },
}

// Prompt-cache reads bill at 10% for the priced Anthropic/OpenAI models here.
// Anthropic writes bill at 125%.
// https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching#pricing
const CACHE_READ_MULTIPLIER = 0.1
const CACHE_WRITE_MULTIPLIER = 1.25

function computeCost(
	fullId: string,
	usage: PartialTokenUsage,
): number {
	const p = PRICING[fullId]
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

const FALLBACK_MODEL = 'openai/gpt-5.5'

const config = {
	// Default model alias or full ID. Set via config.ason under "models".
	default: FALLBACK_MODEL,
}

function defaultModel(): string {
	return resolveModel(config.default)
}

// ── Model listing (for /model command) ──

interface ModelGroup {
	label: string
	models: { alias: string; fullId: string }[]
}

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

const MODEL_GROUPS: ModelGroup[] = [
	{
		label: 'Anthropic',
		models: [
			{ alias: 'opus', fullId: 'anthropic/claude-opus-4-7' },
			{ alias: 'sonnet', fullId: 'anthropic/claude-sonnet-4-6' },
			{ alias: 'haiku', fullId: 'anthropic/claude-haiku-4-5' },
			{ alias: 'fable', fullId: 'anthropic/claude-fable-5' },
		],
	},
	{
		label: 'OpenAI',
		models: [
			{ alias: 'gpt', fullId: 'openai/gpt-5.5' },
			{ alias: 'instant', fullId: 'openai/gpt-5.5-instant' },
			{ alias: 'codex', fullId: 'openai/gpt-5.3-codex' },
		],
	},
	{
		label: 'Google',
		models: [
			{ alias: 'gemini', fullId: 'google/gemini-3.5-flash' },
			{ alias: 'gemini-pro', fullId: 'google/gemini-3.1-pro-preview' },
		],
	},
	{
		label: 'OpenRouter',
		models: [
			{ alias: 'grok', fullId: 'openrouter/x-ai/grok-4.20' },
			{ alias: 'deepseek', fullId: 'openrouter/deepseek/deepseek-chat' },
			{ alias: 'llama', fullId: 'openrouter/meta-llama/llama-4-maverick' },
		],
	},
]

function groupModelEntries(group: ModelGroup): ModelEntry[] {
	const entries: ModelEntry[] = []
	const seen = new Set<string>()
	for (const model of group.models) {
		const fullId = aliasFullId(model.alias) ?? model.fullId
		entries.push({ alias: model.alias, fullId, static: true })
		seen.add(fullId)
	}
	if (group.label !== 'Anthropic' && group.label !== 'OpenAI') return entries
	for (const id of Object.keys(loadModelsDevCache()).sort()) {
		const info = discoveryModelInfo(id)
		if (!info || info.provider !== group.label) continue
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
	const grok = model.fullId.match(/^openrouter\/x-ai\/grok-(.+)$/)
	if (grok) names.add(`grok-${grok[1]}`)
}

function allKnownModelIds(): string[] {
	const ids = new Set<string>()
	for (const id of Object.keys(FALLBACK_WINDOWS)) ids.add(id)
	for (const id of Object.keys(loadModelsDevCache())) {
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
	return [...best.values()].sort(compareCandidates)
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
	for (const candidate of curatedCandidates(parseCodexCandidate, 5)) {
		const fullId = `openai/${candidate.canonical}`
		const value = aliasFullId('codex') === fullId ? 'codex' : candidate.canonical
		addModelChoice(items, value, fullId, ['openai', 'gpt'], `${versionLeaf(candidate.version, true)}-codex`)
	}
	for (const candidate of curatedCandidates(parseGptCandidate, 5)) {
		const fullId = `openai/${candidate.canonical}`
		const value = aliasFullId('gpt') === fullId ? 'gpt' : candidate.canonical
		addModelChoice(items, value, fullId, ['openai', 'gpt'], versionLeaf(candidate.version, true))
	}
	addModelChoice(items, 'instant', aliasFullId('instant') ?? ALIASES.instant!, ['openai', 'gpt'], 'instant')
}

function addStaticProviderChoices(items: ModelChoice[], groupLabel: string, providerPath: string): void {
	const group = MODEL_GROUPS.find((g) => g.label === groupLabel)
	if (!group) return
	for (const model of group.models) {
		const fullId = aliasFullId(model.alias) ?? model.fullId
		addModelChoice(items, model.alias, fullId, [providerPath], model.alias)
	}
}

function listModels(): string[] {
	const lines: string[] = []
	for (const group of MODEL_GROUPS) {
		lines.push(group.label)
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
	addOpenAiChoices(items)
	addAnthropicChoices(items)
	addStaticProviderChoices(items, 'Google', 'google')
	addStaticProviderChoices(items, 'OpenRouter', 'openrouter')
	return items
}

function modelCompletionNames(): string[] {
	const names = new Set<string>()
	for (const group of MODEL_GROUPS) {
		for (const model of groupModelEntries(group)) {
			addModelCompletionNames(names, model)
		}
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
	resolveModel,
	displayModel,
	reasoningEffort,
	contextWindow,
	cachedContextWindow,
	computeCost,
	formatCost,
	formatTokenCount,
	providerName,
	defaultModel,
	listModels,
	listModelChoices,
	modelCompletionNames,
	estimateTokens,
	refreshModels,
	modelChangeMessages,
	aliasUpdateSuggestions,
	modelDiscoveries,
	frontierModelInfo,
}
