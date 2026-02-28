import { estimateTokensSync, type TokenCalibration } from './token-calibration.ts'

// Context windows by model ID prefix (longest prefix wins)
const CONTEXT_WINDOWS: [string, number][] = [
	['gpt-5', 400_000],
	['gpt-4.1', 1_000_000],
	['gpt-4o', 128_000],
	['gpt-4', 128_000],
	['o3', 200_000],
	['o4', 200_000],
	['o1', 200_000],
	['claude', 200_000],
]

const DEFAULT_CONTEXT = 200_000

/** Get context window size for a model ID (without provider prefix). */
export function contextWindowForModel(modelId: string): number {
	// Try longest prefix match
	let bestLen = 0
	let bestSize = DEFAULT_CONTEXT
	for (const [prefix, size] of CONTEXT_WINDOWS) {
		if (modelId.startsWith(prefix) && prefix.length > bestLen) {
			bestLen = prefix.length
			bestSize = size
		}
	}
	return bestSize
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
