// Context window sizes + token estimation.
//
// Estimation purpose (important):
// - Show a rough context % in the status line for fresh/idle tabs BEFORE
//   we have real API usage.
// - Include baseline overhead (system prompt + tool schema) so empty tabs are
//   not shown as 0%.
// - NEVER drive autocompact with estimates. Autocompact must use real API
//   usage.input counts.

import { tokenCalibration } from './token-calibration.ts'

export const contextConfig = {
	windows: {
		'claude-opus-4-6': 200_000,
		'claude-sonnet-4-6': 200_000,
		'claude-opus-4-5': 200_000,
		'claude-sonnet-4-5': 200_000,
		'claude-sonnet-4-20250514': 200_000,
		'gpt-5.4': 1_000_000,
		'gpt-5.3': 400_000,
		'gpt-5.3-codex': 400_000,
		'gpt-5.3-codex-spark': 128_000,
		'gpt-5.2': 256_000,
		'gpt-5.2-codex': 400_000,
	} as Record<string, number>,
	defaultWindow: 200_000,
}

export function contextWindowForModel(modelId: string): number {
	for (const [prefix, size] of Object.entries(contextConfig.windows)) {
		if (modelId.startsWith(prefix)) return size
	}
	return contextConfig.defaultWindow
}

// ── Compatibility wrappers (moved to token-calibration.ts) ──

export function saveCalibration(modelId: string, totalBytes: number, totalTokens: number): void {
	tokenCalibration.saveTokenCalibration(modelId, totalBytes, totalTokens)
}

export function isCalibrated(modelId: string): boolean {
	return tokenCalibration.isModelCalibrated(modelId)
}

// Estimate token count from byte count. Fresh-tab UI only.
export function estimateTokens(bytes: number, modelId: string): number {
	return tokenCalibration.estimateTokensSync(bytes, modelId)
}

// ── Message byte counting (for estimation only) ──

export function messageBytes(msg: any): number {
	if (typeof msg.content === 'string') return msg.content.length
	if (Array.isArray(msg.content)) {
		let bytes = 0
		for (const block of msg.content) {
			if (block.type === 'text') bytes += block.text?.length ?? 0
			else if (block.type === 'thinking') bytes += block.thinking?.length ?? 0
			else if (block.type === 'tool_use') bytes += JSON.stringify(block.input ?? {}).length
			else if (block.type === 'tool_result')
				bytes += typeof block.content === 'string'
					? block.content.length
					: JSON.stringify(block.content ?? '').length
		}
		return bytes
	}
	return 0
}

// Estimate context for API messages with optional fixed overhead bytes
// (e.g. system prompt + tools schema). Returns estimated usage only.
export function estimateContext(
	apiMessages: any[],
	modelId: string,
	overheadBytes = 0,
): { used: number; max: number; estimated: true } {
	let totalBytes = Math.max(0, overheadBytes)
	for (const msg of apiMessages) totalBytes += messageBytes(msg)
	const max = contextWindowForModel(modelId)
	return { used: tokenCalibration.estimateTokensSync(totalBytes, modelId), max, estimated: true as const }
}

export const context = {
	config: contextConfig,
	contextWindowForModel,
	saveCalibration,
	isCalibrated,
	estimateTokens,
	messageBytes,
	estimateContext,
}
