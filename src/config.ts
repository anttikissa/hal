import { readFileSync, writeFileSync } from "fs"
import { stringify, parse } from "./utils/ason.ts"
import { HAL_DIR } from "./state.ts"

const CONFIG_PATH = `${HAL_DIR}/config.ason`

export interface Config {
	provider: string
	model: string
	compactModel?: string
	contextWarnThreshold: number
	maxConcurrentSessions: number
}

// User-facing aliases → actual model IDs
export const MODEL_ALIASES: Record<string, string> = {
	claude: "claude-opus-4-6",
	codex: "gpt-5.3-codex",
}

export const COMPACT_MODEL_FOR: Record<string, string> = {
	claude: "claude-sonnet-4-20250514",
	codex: "gpt-5.1-mini",
}

// Reverse lookup: model ID → alias
export function modelAlias(modelId: string): string {
	for (const [alias, id] of Object.entries(MODEL_ALIASES)) {
		if (id === modelId) return alias
	}
	return modelId
}

export function resolveModel(nameOrId: string): string {
	return MODEL_ALIASES[nameOrId] ?? nameOrId
}

export function resolveCompactModel(nameOrId: string): string {
	return COMPACT_MODEL_FOR[nameOrId] ?? nameOrId
}

// Provider detection from model name/alias
export function providerForModel(nameOrId: string): string {
	const id = resolveModel(nameOrId)
	if (id.startsWith("claude") || id.startsWith("anthropic")) return "anthropic"
	if (id.startsWith("gpt") || id.startsWith("o1") || id.startsWith("o3") || id.startsWith("o4")) return "openai"
	// Fallback: check alias
	if (nameOrId === "claude") return "anthropic"
	if (nameOrId === "codex") return "openai"
	return "anthropic"
}

const DEFAULTS: Config = {
	provider: "anthropic",
	model: "claude",
	contextWarnThreshold: 0.8,
	maxConcurrentSessions: 2,
}

let _config: Config | null = null

export function loadConfig(): Config {
	if (_config) return _config
	try {
		const raw = readFileSync(CONFIG_PATH, "utf-8")
		_config = { ...DEFAULTS, ...parse(raw) }
	} catch {
		_config = { ...DEFAULTS }
	}
	return _config!
}

export function saveConfig(config: Config): void {
	_config = config
	writeFileSync(CONFIG_PATH, stringify(config) + "\n")
}

export function updateConfig(updates: Partial<Config>): Config {
	const config = { ...loadConfig(), ...updates }
	saveConfig(config)
	return config
}
