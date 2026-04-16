// Model registry — aliases, display names, pricing, context windows.
import type { PartialTokenUsage } from './protocol.ts'
//
// Models are identified as "provider/model-id" (e.g. "anthropic/claude-opus-4-6").
// Short aliases like "opus" resolve to full IDs. Display names are extracted
// from model IDs via regex patterns for human-readable UI.

// ── Aliases ──
// Short name → full provider/model-id

const ALIASES: Record<string, string> = {
	anthropic: 'anthropic/claude-opus-4-6',
	claude: 'anthropic/claude-opus-4-6',
	opus: 'anthropic/claude-opus-4-6',
	sonnet: 'anthropic/claude-sonnet-4-20250514',
	haiku: 'anthropic/claude-haiku-4-5-20251001',
	openai: 'openai/gpt-5.3-codex',
	gpt: 'openai/gpt-5.4',
	codex: 'openai/gpt-5.3-codex',
	gemini: 'google/gemini-2.5-flash',
	'gemini-pro': 'google/gemini-2.5-pro',
	grok: 'openrouter/x-ai/grok-4',
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
	if (/^o\d/.test(modelId) || modelId.startsWith('gpt-5.4')) return 'high'
	return ''
}

// ── Context windows (tokens) ──
// Fetched from models.dev on startup and cached in state/models.ason.
// Falls back to hardcoded defaults if the file doesn't exist yet.

import { readFileSync, writeFileSync } from 'fs'
import { STATE_DIR, ensureDir } from './state.ts'
import { ason } from './utils/ason.ts'

const MODELS_FILE = `${STATE_DIR}/models.ason`
const DEFAULT_CONTEXT = 200_000

// Hardcoded fallbacks — used before first models.dev fetch completes
const FALLBACK_WINDOWS: Record<string, number> = {
	'anthropic/claude-opus-4-6': 200_000,
	'anthropic/claude-sonnet-4-20250514': 200_000,
	'anthropic/claude-haiku-4-5-20251001': 200_000,
	'openai/gpt-5.4': 1_050_000,
	'openai/gpt-5.3': 128_000,
	'openai/gpt-5.3-codex': 128_000,
	'google/gemini-2.5-flash': 1_000_000,
	'google/gemini-2.5-pro': 1_000_000,
}

// Lazy-loaded context window map from models.dev (state/models.ason).
// Keys are bare model IDs (without provider prefix), values are token counts.
let _modelsDevCache: Record<string, number> | null = null

function loadModelsDevCache(): Record<string, number> {
	if (_modelsDevCache) return _modelsDevCache
	try {
		_modelsDevCache = ason.parse(readFileSync(MODELS_FILE, 'utf-8')) as Record<string, number>
	} catch {
		_modelsDevCache = {}
	}
	return _modelsDevCache
}

/** Fetch context windows from models.dev and save to state/models.ason.
 *  Fire-and-forget on startup. The file persists across restarts. */
async function refreshModels(): Promise<void> {
	const res = await fetch('https://models.dev/api.json', { signal: AbortSignal.timeout(10_000) })
	const data = (await res.json()) as Record<string, { models?: Record<string, any> }>
	const ctx: Record<string, number> = {}
	for (const provider of Object.values(data)) {
		for (const [id, model] of Object.entries(provider.models ?? {})) {
			if (model.limit?.context) ctx[id] = model.limit.context
		}
	}
	ensureDir(STATE_DIR)
	writeFileSync(MODELS_FILE, ason.stringify(ctx) + '\n')
	_modelsDevCache = ctx
}

function contextWindow(fullId: string): number {
	// 1. Check hardcoded fallbacks (full provider/model-id)
	if (FALLBACK_WINDOWS[fullId]) return FALLBACK_WINDOWS[fullId]

	// 2. Check models.dev cache (bare model ID, no provider prefix)
	const bare = fullId.includes('/') ? fullId.slice(fullId.indexOf('/') + 1) : fullId
	const cached = loadModelsDevCache()
	if (cached[bare]) return cached[bare]
	// Also try exact full ID in case the cache uses it
	if (cached[fullId]) return cached[fullId]

	return DEFAULT_CONTEXT
}

// ── Pricing (USD per million tokens) ──

const PRICING: Record<string, { input: number; output: number }> = {
	'anthropic/claude-opus-4-6': { input: 5, output: 25 },
	'anthropic/claude-sonnet-4-20250514': { input: 3, output: 15 },
	'anthropic/claude-haiku-4-5-20251001': { input: 1, output: 5 },
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

const FALLBACK_MODEL = 'anthropic/claude-opus-4-6'

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
			{ alias: 'opus', fullId: 'anthropic/claude-opus-4-6' },
			{ alias: 'sonnet', fullId: 'anthropic/claude-sonnet-4-20250514' },
			{ alias: 'haiku', fullId: 'anthropic/claude-haiku-4-5-20251001' },
		],
	},
	{
		label: 'OpenAI',
		models: [
			{ alias: 'gpt', fullId: 'openai/gpt-5.4' },
			{ alias: 'codex', fullId: 'openai/gpt-5.3-codex' },
		],
	},
	{
		label: 'Google',
		models: [
			{ alias: 'gemini', fullId: 'google/gemini-2.5-flash' },
			{ alias: 'gemini-pro', fullId: 'google/gemini-2.5-pro' },
		],
	},
	{
		label: 'OpenRouter',
		models: [
			{ alias: 'grok', fullId: 'openrouter/x-ai/grok-4' },
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
	config,
	resolveModel,
	displayModel,
	reasoningEffort,
	contextWindow,
	computeCost,
	formatCost,
	formatTokenCount,
	providerName,
	defaultModel,
	listModels,
	listModelChoices,
	estimateTokens,
	refreshModels,
}
