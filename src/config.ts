import { readFileSync, writeFileSync, watch } from 'fs'
import { stringify, parse } from './utils/ason.ts'
import { HAL_DIR } from './state.ts'

const CONFIG_PATH = `${HAL_DIR}/config.ason`

export interface DebugTokensConfig {
	sys?: boolean // system prompt token count on first response per session
	spam?: boolean // token counts on every response
	context?: boolean // context percentage in scrollback
}

export interface DebugConfig {
	toolCalls?: boolean // log tool calls to state/tool-calls.asonl
	responseLogging?: boolean // log API responses to state/responses.asonl
	ipc?: boolean // log IPC commands/events
	streaming?: boolean // log raw SSE events
	tokens?: DebugTokensConfig // token logging
	recordEverything?: boolean // streaming debug log: state files, keypresses, snapshots
	maxDiskBytes?: number // max bytes for state/debug + state/bugs (default: 2 GiB)
}

export type ProviderProtocol = 'openai-completions'

export interface ProviderConfig {
	protocol: ProviderProtocol
	baseUrl: string
	auth?: 'none' | 'apiKey'
	headers?: Record<string, string>
	maxTokensField?: 'max_tokens' | 'max_completion_tokens'
	includeUsageInStream?: boolean
}
export interface Config {
	defaultModel: string // "provider/model-id", e.g. "anthropic/claude-opus-4-6"
	compactModel?: string
	ollamaBaseUrl?: string // deprecated: use providers.ollama.baseUrl
	theme: string // theme name, resolved to themes/<name>.ason
	timestamps?: boolean // show timestamps in TUI output
	userCursor: 'native' | 'block' // 'block' = fake blinking block, 'native' = hardware cursor
	cursorBlinkIdle: number // HAL cursor blink period when idle (ms)
	cursorBlinkBusy: number // HAL cursor blink period when busy (ms)
	cursorBlinkUser: number // user cursor blink period (ms)
	contextWarnThreshold: number
	maxConcurrentSessions: number
	maxPromptLines: number
	providers?: Record<string, ProviderConfig>
	modelAliases?: Record<string, string>
	debug: DebugConfig
}


// User-facing aliases → full provider/model strings
export const MODEL_ALIASES: Record<string, string> = {
	claude: 'anthropic/claude-opus-4-6',
	codex: 'openai/gpt-5.3-codex',
	mock: 'mock/mock-1',
	ollama: 'ollama/llama3.2',
}

export const COMPACT_MODEL_FOR: Record<string, string> = {
	'anthropic/claude-opus-4-6': 'anthropic/claude-sonnet-4-20250514',
	'openai/gpt-5.3-codex': 'openai/gpt-5.1-mini',
}

export function mergedModelAliases(): Record<string, string> {
	const configured = loadConfig().modelAliases
	return configured && typeof configured === 'object'
		? { ...MODEL_ALIASES, ...configured }
		: { ...MODEL_ALIASES }
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
		model.startsWith('o4') ||
		model.startsWith('codex')
	)
		return { provider: 'openai', modelId: model }
	if (model.startsWith('ollama')) return { provider: 'ollama', modelId: model }
	return { provider: 'anthropic', modelId: model }
}

/** Resolve alias or pass through. Always returns "provider/model-id". */
export function resolveModel(nameOrId: string): string {
	const aliases = mergedModelAliases()
	if (aliases[nameOrId]) return aliases[nameOrId]
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
	for (const [alias, full] of Object.entries(mergedModelAliases())) {
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
	defaultModel: 'anthropic/claude-opus-4-6',
	theme: 'default',
	userCursor: 'block',
	cursorBlinkIdle: 1000,
	cursorBlinkBusy: 500,
	cursorBlinkUser: 500,
	contextWarnThreshold: 0.8,
	maxConcurrentSessions: 4,
	maxPromptLines: 15,
	debug: {},
}


let _config: Config | null = null
try { watch(CONFIG_PATH, () => { _config = null }) } catch {}

export function resetConfigCache(): void {
	_config = null
}

export function loadConfig(): Config {
	if (_config) return _config
	try {
		const raw = readFileSync(CONFIG_PATH, 'utf-8')
		const parsed = parse(raw, { comments: true }) as any
		// Migrate: 'model' → 'defaultModel'
		if (parsed.model && !parsed.defaultModel) {
			parsed.defaultModel = parsed.model
			delete parsed.model
		}
		// Migrate old format: if provider field exists and defaultModel has no slash, combine them
		if (parsed.provider && parsed.defaultModel && !parsed.defaultModel.includes('/')) {
			parsed.defaultModel = `${parsed.provider}/${resolveModel(parsed.defaultModel).split('/').pop()}`
			delete parsed.provider
		} else if (parsed.defaultModel && !parsed.defaultModel.includes('/')) {
			// Bare alias or model ID — resolve to full form
			parsed.defaultModel = resolveModel(parsed.defaultModel)
		}
		if (parsed.ollamaBaseUrl && (!parsed.providers || typeof parsed.providers !== 'object')) {
			const base = String(parsed.ollamaBaseUrl).trim().replace(/\/+$/, '')
			parsed.providers = {
				ollama: {
					protocol: 'openai-completions',
					baseUrl: base.endsWith('/v1') ? base : `${base}/v1`,
					auth: 'none',
				},
			}
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

const DEFAULT_DEBUG_MAX_DISK_BYTES = 2 * 1024 * 1024 * 1024

export function debugMaxDiskBytes(): number {
	const raw = loadConfig().debug?.maxDiskBytes
	if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return DEFAULT_DEBUG_MAX_DISK_BYTES
	return Math.floor(raw)
}
