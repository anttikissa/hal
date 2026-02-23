import { readFile, writeFile } from 'fs/promises'
import { stringify, parse } from './utils/ason.ts'
import { CALIBRATION_FILE } from './state.ts'

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

export function estimateMessageTokens(msg: any, calibration?: Calibration | null): number {
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

// Calibration

interface Calibration {
	systemBytes: number
	systemTokens: number
	bytesPerToken: number
	calibratedAt: string
}

const DEFAULT_BYTES_PER_TOKEN = 4

export async function getCalibration(): Promise<Calibration | null> {
	try {
		return parse(await readFile(CALIBRATION_FILE, 'utf-8')) as Calibration
	} catch {
		return null
	}
}

export async function saveCalibration(systemBytes: number, systemTokens: number): Promise<void> {
	const cal: Calibration = {
		systemBytes,
		systemTokens,
		bytesPerToken: systemBytes / systemTokens,
		calibratedAt: new Date().toISOString(),
	}
	await writeFile(CALIBRATION_FILE, stringify(cal) + '\n')
}

export function estimateTokensSync(bytes: number, calibration: Calibration | null): number {
	const ratio = calibration?.bytesPerToken ?? DEFAULT_BYTES_PER_TOKEN
	return Math.ceil(bytes / ratio)
}
