import { readFileSync, writeFileSync } from 'fs'
import { stringify, parse } from './utils/ason.ts'
import { HAL_DIR } from './state.ts'

const CONFIG_PATH = `${HAL_DIR}/config.ason`

export interface DebugTokensConfig {
	sys?: boolean // system prompt token count on first response per session
	spam?: boolean // token counts on every response
	context?: boolean // context percentage in scrollback
}

export interface DebugConfig {
	toolCalls?: boolean // log tool calls to state/tool-calls.ason
	responseLogging?: boolean // log API responses to state/responses.ason
	ipc?: boolean // log IPC commands/events
	streaming?: boolean // log raw SSE events
	tokens?: DebugTokensConfig // token logging
	recordEverything?: boolean // streaming debug log: state files, keypresses, snapshots
}

export interface Config {
	model: string // "provider/model-id", e.g. "anthropic/claude-opus-4-6"
	compactModel?: string
	theme: string // theme name, resolved to themes/<name>.ason
	contextWarnThreshold: number
	maxConcurrentSessions: number
	maxPromptLines: number
	debug: DebugConfig
}


// User-facing aliases → full provider/model strings
export const MODEL_ALIASES: Record<string, string> = {
	claude: 'anthropic/claude-opus-4-6',
	codex: 'openai/gpt-5.3-codex',
	mock: 'mock/mock-1',
}

export const COMPACT_MODEL_FOR: Record<string, string> = {
	'anthropic/claude-opus-4-6': 'anthropic/claude-sonnet-4-20250514',
	'openai/gpt-5.3-codex': 'openai/gpt-5.1-mini',
}

/** Parse "provider/model-id" → { provider, modelId } */
export function parseModel(model: string): { provider: string; modelId: string } {
	const slash = model.indexOf('/')
	if (slash > 0) return { provider: model.slice(0, slash), modelId: model.slice(slash + 1) }
	// Bare model name — infer provider
	if (model.startsWith('mock')) return { provider: 'mock', modelId: model }
	if (model.startsWith('claude') || model.startsWith('anthropic'))
		return { provider: 'anthropic', modelId: model }
	if (
		model.startsWith('gpt') ||
		model.startsWith('o1') ||
		model.startsWith('o3') ||
		model.startsWith('o4')
	)
		return { provider: 'openai', modelId: model }
	return { provider: 'anthropic', modelId: model }
}

/** Resolve alias or pass through. Always returns "provider/model-id". */
export function resolveModel(nameOrId: string): string {
	if (MODEL_ALIASES[nameOrId]) return MODEL_ALIASES[nameOrId]
	// Already has provider prefix
	if (nameOrId.includes('/')) return nameOrId
	// Bare model ID — add provider
	const { provider, modelId } = parseModel(nameOrId)
	return `${provider}/${modelId}`
}

/** Extract provider from a model string (alias, full, or bare) */
export function providerForModel(nameOrId: string): string {
	return parseModel(resolveModel(nameOrId)).provider
}

/** Extract model ID (without provider) from a model string */
export function modelIdForModel(nameOrId: string): string {
	return parseModel(resolveModel(nameOrId)).modelId
}

/** Reverse lookup: "provider/model-id" → alias (or short display name) */
export function modelAlias(fullModel: string): string {
	for (const [alias, full] of Object.entries(MODEL_ALIASES)) {
		if (full === fullModel) return alias
	}
	// Strip provider prefix for display
	const { modelId } = parseModel(fullModel)
	return modelId
}

export function resolveCompactModel(model: string): string {
	const full = resolveModel(model)
	return COMPACT_MODEL_FOR[full] ?? full
}

const DEFAULTS: Config = {
	model: 'anthropic/claude-opus-4-6',
	theme: 'default',
	contextWarnThreshold: 0.8,
	maxConcurrentSessions: 4,
	maxPromptLines: 15,
	debug: {},
}


let _config: Config | null = null

export function loadConfig(): Config {
	if (_config) return _config
	try {
		const raw = readFileSync(CONFIG_PATH, 'utf-8')
		const parsed = parse(raw) as any
		// Migrate old format: if provider field exists and model has no slash, combine them
		if (parsed.provider && parsed.model && !parsed.model.includes('/')) {
			parsed.model = `${parsed.provider}/${resolveModel(parsed.model).split('/').pop()}`
			delete parsed.provider
		} else if (parsed.model && !parsed.model.includes('/')) {
			// Bare alias or model ID — resolve to full form
			parsed.model = resolveModel(parsed.model)
		}
		_config = { ...DEFAULTS, ...parsed }
	} catch {
		_config = { ...DEFAULTS }
	}
	return _config!
}

export function saveConfig(config: Config): void {
	_config = config
	writeFileSync(CONFIG_PATH, stringify(config) + '\n')
}

export function updateConfig(updates: Partial<Config>): Config {
	const config = { ...loadConfig(), ...updates }
	saveConfig(config)
	return config
}

export function debugEnabled(flag: keyof DebugConfig): boolean {
	const val = loadConfig().debug?.[flag]
	return val === true || (typeof val === 'object' && val !== null)
}

export function debugTokens(flag: keyof DebugTokensConfig): boolean {
	const tokens = loadConfig().debug?.tokens
	if (!tokens || typeof tokens !== 'object') return false
	return tokens[flag] === true
}
