// Model registry — aliases, display names, pricing, context windows.
import type { PartialTokenUsage } from './protocol.ts'
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
	openai: 'openai/gpt-5.5',
	gpt: 'openai/gpt-5.5',
	codex: 'openai/gpt-5.3-codex',
	gemini: 'google/gemini-3-flash-preview',
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
	[/^gpt-?(\d+\.\d+)$/, 'openai/gpt-$1'],
	[/^gemini-(.+)$/, 'google/gemini-$1'],
	[/^grok-(.+)$/, 'openrouter/x-ai/grok-$1'],
]

function resolveModel(input: string): string {
	if (input.includes('/')) return input
	if (ALIASES[input]) return ALIASES[input]
	for (const [re, replacement] of PATTERNS) {
		if (re.test(input)) return input.replace(re, replacement)
	}
	return input
}

// ── Display names ──
// Regex patterns to extract human-readable names from model IDs.

const DISPLAY_PATTERNS: [RegExp, (m: RegExpMatchArray) => string][] = [
	// claude-haiku-4-5-20251001 → Haiku 4.5
	[
		/^claude-(opus|sonnet|haiku)-(\d+)-(\d+)-\d{8,}$/,
		(m) => {
			const tier = m[1]![0]!.toUpperCase() + m[1]!.slice(1)
			return `${tier} ${m[2]}.${m[3]}`
		},
	],
	// claude-opus-4-6 → Opus 4.6
	[
		/^claude-(opus|sonnet|haiku)-(\d+)-(\d{1,2})$/,
		(m) => {
			const tier = m[1]![0]!.toUpperCase() + m[1]!.slice(1)
			return `${tier} ${m[2]}.${m[3]}`
		},
	],
	// claude-sonnet-4-20250514 → Sonnet 4
	[
		/^claude-(opus|sonnet|haiku)-(\d+)-\d{8,}$/,
		(m) => {
			const tier = m[1]![0]!.toUpperCase() + m[1]!.slice(1)
			return `${tier} ${m[2]}`
		},
	],
	// gpt-5.3-codex → Codex 5.3
	[/^gpt-(\d+\.\d+)-codex$/, (m) => `Codex ${m[1]}`],
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
	'openai/gpt-5.5': 1_050_000,
	'openai/gpt-5.4': 1_050_000,
	'openai/gpt-5.3': 128_000,
	'openai/gpt-5.3-codex': 128_000,
	'google/gemini-3-flash-preview': 1_000_000,
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
	return /(^|\/)gpt-[\d.]+/.test(id) || /(^|\/)claude-(opus|sonnet|haiku)-/.test(id)
}

function parseVersionParts(text: string): number[] {
	return text.split('.').map((part) => Number(part))
}

function frontierModelInfo(fullId: string): FrontierModelInfo | null {
	const id = fullId.includes('/') ? fullId.slice(fullId.indexOf('/') + 1) : fullId
	const gpt = id.match(/^gpt-(\d+)\.(\d+)$/)
	if (gpt) return { kind: 'gpt', family: `GPT ${gpt[1]}`, version: [Number(gpt[1]), Number(gpt[2])] }

	const claude = id.match(/^claude-(opus|sonnet|haiku)-(\d+)(?:[.-](\d+)|-\d{8,})?$/)
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

function parseClaudeCandidate(tier: 'opus' | 'sonnet' | 'haiku', modelId: string): ModelCandidate | null {
	const match = modelId.match(new RegExp(`^claude-${tier}-(\\d+)(?:[.-](\\d+)|-(\\d{8,}))?$`))
	if (!match) return null
	const major = Number(match[1])
	const minor = Number(match[2] ?? 0)
	const canonical = match[2] ? `claude-${tier}-${major}-${minor}` : `claude-${tier}-${major}`
	return { canonical, version: [major, minor], stability: match[2] ? 2 : match[3] ? 0 : 1 }
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
	{ aliases: ['openai', 'gpt'], latest: (cache: Record<string, number>) => newestMatchingModel(cache, parseGptCandidate) },
	{ aliases: ['codex'], latest: (cache: Record<string, number>) => newestMatchingModel(cache, parseCodexCandidate) },
	{ aliases: ['gemini'], latest: (cache: Record<string, number>) => newestMatchingModel(cache, (id) => parseGeminiCandidate('flash', id)) },
	{ aliases: ['gemini-pro'], latest: (cache: Record<string, number>) => newestMatchingModel(cache, (id) => parseGeminiCandidate('pro', id)) },
	{ aliases: ['grok'], latest: (cache: Record<string, number>) => newestMatchingModel(cache, parseGrokCandidate) },
]

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
			const family = id.includes('gpt-') ? 'GPT' : 'Claude'
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

function contextWindow(fullId: string): number {
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
}

// Anthropic prompt-cache multipliers: reads bill at 10% of input, writes at 125%.
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

const MODEL_GROUPS: ModelGroup[] = [
	{
		label: 'Anthropic',
		models: [
			{ alias: 'opus', fullId: 'anthropic/claude-opus-4-7' },
			{ alias: 'sonnet', fullId: 'anthropic/claude-sonnet-4-6' },
			{ alias: 'haiku', fullId: 'anthropic/claude-haiku-4-5' },
		],
	},
	{
		label: 'OpenAI',
		models: [
			{ alias: 'gpt', fullId: 'openai/gpt-5.5' },
			{ alias: 'codex', fullId: 'openai/gpt-5.3-codex' },
		],
	},
	{
		label: 'Google',
		models: [
			{ alias: 'gemini', fullId: 'google/gemini-3-flash-preview' },
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

function listModels(): string[] {
	const lines: string[] = []
	for (const group of MODEL_GROUPS) {
		lines.push(group.label)
		for (const m of group.models) {
			lines.push(`  ${m.alias.padEnd(14)} ${m.fullId}`)
		}
		lines.push('')
	}
	lines.push('Patterns: opus-X, sonnet-X, haiku-X, gpt-X.Y, gemini-X, grok-X')
	return lines
}

function listModelChoices(): Array<{ value: string; label: string; search: string }> {
	const items: Array<{ value: string; label: string; search: string }> = []
	for (const group of MODEL_GROUPS) {
		for (const model of group.models) {
			const label = `${model.alias.padEnd(14)} ${displayModel(model.fullId)} · ${model.fullId}`
			items.push({
				value: model.alias,
				label,
				search: `${group.label} ${model.alias} ${model.fullId} ${displayModel(model.fullId)}`.toLowerCase(),
			})
		}
	}
	return items
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
	estimateTokens,
	refreshModels,
	modelChangeMessages,
	aliasUpdateSuggestions,
	frontierModelInfo,
}
