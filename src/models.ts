// Model registry — aliases, display names, pricing, context windows.
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
			const tier = m[1][0].toUpperCase() + m[1].slice(1)
			return `${tier} ${m[2]}.${m[3]}`
		},
	],
	// claude-opus-4-6 → Opus 4.6
	[
		/^claude-(opus|sonnet|haiku)-(\d+)-(\d{1,2})$/,
		(m) => {
			const tier = m[1][0].toUpperCase() + m[1].slice(1)
			return `${tier} ${m[2]}.${m[3]}`
		},
	],
	// claude-sonnet-4-20250514 → Sonnet 4
	[
		/^claude-(opus|sonnet|haiku)-(\d+)-\d{8,}$/,
		(m) => {
			const tier = m[1][0].toUpperCase() + m[1].slice(1)
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

// ── Context windows (tokens) ──

const CONTEXT_WINDOWS: Record<string, number> = {
	'anthropic/claude-opus-4-6': 200_000,
	'anthropic/claude-sonnet-4-20250514': 200_000,
	'anthropic/claude-haiku-4-5-20251001': 200_000,
	'openai/gpt-5.4': 128_000,
	'openai/gpt-5.3': 128_000,
	'openai/gpt-5.3-codex': 128_000,
	'google/gemini-2.5-flash': 1_000_000,
	'google/gemini-2.5-pro': 1_000_000,
}

function contextWindow(fullId: string): number {
	return CONTEXT_WINDOWS[fullId] ?? 200_000
}

// ── Pricing (USD per million tokens) ──

const PRICING: Record<string, { input: number; output: number }> = {
	'anthropic/claude-opus-4-6': { input: 5, output: 25 },
	'anthropic/claude-sonnet-4-20250514': { input: 3, output: 15 },
	'anthropic/claude-haiku-4-5-20251001': { input: 1, output: 5 },
}

function computeCost(fullId: string, usage: { input: number; output: number }): number {
	const p = PRICING[fullId]
	if (!p) return 0
	return (usage.input * p.input + usage.output * p.output) / 1_000_000
}

function formatCost(fullId: string, usage: { input: number; output: number }): string {
	const cost = computeCost(fullId, usage)
	if (cost === 0) return ''
	return `$${cost.toFixed(4)}`
}

// ── Default model ──

function defaultModel(): string {
	return process.env.HAL_MODEL ? resolveModel(process.env.HAL_MODEL) : 'anthropic/claude-opus-4-6'
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

// ── Token estimation ──
// Rough estimate: ~4 chars per token for English text.
// This is only for UI display — real token counts come from provider responses.

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4)
}

export const models = {
	resolveModel,
	displayModel,
	contextWindow,
	computeCost,
	formatCost,
	defaultModel,
	listModels,
	estimateTokens,
}
