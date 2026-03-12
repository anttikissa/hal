// Model aliases and display names.

// ── Aliases ──
// Short name → full provider/model-id

const ALIASES: Record<string, string> = {
	claude: 'anthropic/claude-opus-4-6',
	opus: 'anthropic/claude-opus-4-6',
	sonnet: 'anthropic/claude-sonnet-4-20250514',
	'gpt54': 'openai/gpt-5.4',
	'gpt53': 'openai/gpt-5.3',
	'gpt52': 'openai/gpt-5.2',
	codex: 'openai/gpt-5.3-codex',
	'codex-spark': 'openai/gpt-5.3-codex-spark',
	mock: 'mock/mock-1',
}

export function modelCompletions(): string[] {
	const values = new Set<string>(Object.keys(ALIASES))
	for (const v of Object.values(ALIASES)) values.add(v)
	return [...values].sort((a, b) => a.localeCompare(b))
}

// Pattern-based alias: opus-X → anthropic/claude-opus-X, sonnet-X → anthropic/claude-sonnet-X
const PATTERNS: [RegExp, string][] = [
	[/^opus-(.+)$/, 'anthropic/claude-opus-$1'],
	[/^sonnet-(.+)$/, 'anthropic/claude-sonnet-$1'],
	[/^gpt-?(\d+\.\d+)$/, 'openai/gpt-$1'],
	[/^codex-(.+)$/, 'openai/gpt-$1-codex'],
]

export function resolveModel(input: string): string {
	if (input.includes('/')) return input
	if (ALIASES[input]) return ALIASES[input]
	for (const [re, replacement] of PATTERNS) {
		if (re.test(input)) return input.replace(re, replacement)
	}
	return input
}

// ── Display names ──
// Full model ID → human-readable short name

const DISPLAY_PATTERNS: [RegExp, (m: RegExpMatchArray) => string][] = [
	[/^claude-(opus|sonnet)-(\d+)-(\d{1,2})$/, m => {
		const tier = m[1][0].toUpperCase() + m[1].slice(1)
		return `${tier} ${m[2]}.${m[3]}`
	}],
	// claude-sonnet-4-20250514 → Sonnet 4
	[/^claude-(opus|sonnet)-(\d+)-\d{8,}$/, m => {
		const tier = m[1][0].toUpperCase() + m[1].slice(1)
		return `${tier} ${m[2]}`
	}],
	// gpt-5.3-codex-spark → Codex Spark 5.3, gpt-5.3-codex → Codex 5.3
	[/^gpt-(\d+\.\d+)-codex-spark$/, m => `Codex Spark ${m[1]}`],
	[/^gpt-(\d+\.\d+)-codex$/, m => `Codex ${m[1]}`],
	// gpt-5.4 → GPT 5.4
	[/^gpt-(\d+\.\d+)$/, m => `GPT ${m[1]}`],
]

export function displayModel(fullId: string | undefined): string {
	if (!fullId) return ''
	const modelId = fullId.includes('/') ? fullId.slice(fullId.indexOf('/') + 1) : fullId
	for (const [re, fmt] of DISPLAY_PATTERNS) {
		const m = modelId.match(re)
		if (m) return fmt(m)
	}
	return modelId
}

// ── Fast model resolution ──

import { config } from './config.ts'
import { auth } from './runtime/auth.ts'

const FAST_DEFAULTS: [string, string][] = [
	['anthropic', 'anthropic/claude-3-5-haiku-20241022'],
	['openai', 'openai/gpt-4o-mini'],
]

export function resolveFastModel(): string {
	const cfg = config.getConfig()
	const fast = cfg.fastModel
	if (fast && fast !== 'auto') return resolveModel(fast)

	for (const [provider, model] of FAST_DEFAULTS) {
		if (auth.getAuth(provider).accessToken) return model
	}
	return ''
}

// ── Model listing ──

interface ModelEntry { alias: string; fullId: string; display: string }

const PROVIDERS: { key: string; label: string; models: ModelEntry[] }[] = [
	{
		key: 'anthropic', label: 'Anthropic',
		models: [
			{ alias: 'opus', fullId: 'anthropic/claude-opus-4-6', display: 'Opus 4.6' },
			{ alias: 'sonnet', fullId: 'anthropic/claude-sonnet-4-20250514', display: 'Sonnet 4' },
		],
	},
	{
		key: 'openai', label: 'OpenAI',
		models: [
			{ alias: 'gpt54', fullId: 'openai/gpt-5.4', display: 'GPT 5.4' },
			{ alias: 'gpt53', fullId: 'openai/gpt-5.3', display: 'GPT 5.3' },
			{ alias: 'gpt52', fullId: 'openai/gpt-5.2', display: 'GPT 5.2' },
			{ alias: 'codex', fullId: 'openai/gpt-5.3-codex', display: 'Codex 5.3' },
			{ alias: 'codex-spark', fullId: 'openai/gpt-5.3-codex-spark', display: 'Codex Spark 5.3' },
		],
	},
]

export function listModels(hasAuth: (provider: string) => boolean): string[] {
	const sorted = [...PROVIDERS].sort((a, b) => {
		const aAuth = hasAuth(a.key) ? 0 : 1
		const bAuth = hasAuth(b.key) ? 0 : 1
		return aAuth - bAuth
	})
	const lines: string[] = []
	for (const provider of sorted) {
		const authed = hasAuth(provider.key)
		lines.push(`${provider.label}${authed ? ' ✓' : ''}`)
		for (const m of provider.models) {
			lines.push(`  ${m.alias.padEnd(14)} ${m.fullId}`)
		}
		lines.push('')
	}
	// Also list pattern aliases
	lines.push('Patterns: opus-X, sonnet-X, gpt-X.Y, codex-X.Y')
	return lines
}

export const models = { modelCompletions, resolveModel, displayModel, resolveFastModel, listModels }