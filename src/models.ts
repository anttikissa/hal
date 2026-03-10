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

export const models = { modelCompletions, resolveModel, displayModel }
