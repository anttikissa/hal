import { readFileSync, writeFileSync } from 'fs'
import { estimateTokensSync, type TokenCalibration } from './token-calibration.ts'
import { parse, stringify } from './utils/ason.ts'
import { MODELS_FILE } from './state.ts'

const DEFAULT_CONTEXT = 200_000

// Lazy-loaded context window map from models.dev (state/models.ason)
let _contextWindows: Record<string, number> | null = null

function loadContextWindows(): Record<string, number> {
	if (_contextWindows) return _contextWindows
	try {
		_contextWindows = parse(readFileSync(MODELS_FILE, 'utf-8')) as Record<string, number>
	} catch {
		_contextWindows = {}
	}
	return _contextWindows
}

/** Reset cached data (e.g. after refresh). */
export function resetModelCache(): void {
	_contextWindows = null
}

/** Fetch context windows from models.dev and save to state/models.ason. */
export async function refreshModels(): Promise<void> {
	const res = await fetch('https://models.dev/api.json', { signal: AbortSignal.timeout(10_000) })
	const data = (await res.json()) as Record<string, { models?: Record<string, any> }>
	const ctx: Record<string, number> = {}
	for (const provider of Object.values(data)) {
		for (const [id, model] of Object.entries(provider.models ?? {})) {
			if (model.limit?.context) ctx[id] = model.limit.context
		}
	}
	writeFileSync(MODELS_FILE, stringify(ctx) + '\n')
	_contextWindows = ctx
}

/** Get context window size for a model ID (without provider prefix). */
export function contextWindowForModel(modelId: string): number {
	return loadContextWindows()[modelId] ?? DEFAULT_CONTEXT
}

export function totalInputTokens(usage: any): number {
	return (
		(usage.input_tokens ?? 0) +
		(usage.cache_creation_input_tokens ?? 0) +
		(usage.cache_read_input_tokens ?? 0)
	)
}

export function shouldWarn(usage: any, contextWindow: number): boolean {
	return totalInputTokens(usage) / contextWindow >= 0.666
}

export function estimateMessageTokens(msg: any, calibration?: TokenCalibration | null): number {
	if (typeof msg.content === 'string') return estimateTokensSync(msg.content.length, calibration ?? null)
	if (Array.isArray(msg.content)) {
		let chars = 0
		for (const block of msg.content) {
			if (block.type === 'text') chars += block.text?.length ?? 0
			else if (block.type === 'thinking') chars += block.thinking?.length ?? 0
			else if (block.type === 'tool_use') chars += JSON.stringify(block.input ?? {}).length
			else if (block.type === 'tool_result')
				chars +=
					typeof block.content === 'string'
						? block.content.length
						: JSON.stringify(block.content ?? '').length
		}
		return estimateTokensSync(chars, calibration ?? null)
	}
	return 0
}
