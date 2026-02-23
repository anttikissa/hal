import { estimateTokensSync, type TokenCalibration } from './token-calibration.ts'

export const MAX_CONTEXT = 200_000

export function totalInputTokens(usage: any): number {
	return (
		(usage.input_tokens ?? 0) +
		(usage.cache_creation_input_tokens ?? 0) +
		(usage.cache_read_input_tokens ?? 0)
	)
}

export function shouldWarn(usage: any): boolean {
	return totalInputTokens(usage) / MAX_CONTEXT >= 0.666
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
