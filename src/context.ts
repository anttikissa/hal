import { readFile, writeFile } from 'fs/promises'
import { stringify, parse } from './utils/ason.ts'
import { CALIBRATION_FILE } from './state.ts'

export const MAX_CONTEXT = 200_000

function totalInputTokens(usage: any): number {
	return (
		(usage.input_tokens ?? 0) +
		(usage.cache_creation_input_tokens ?? 0) +
		(usage.cache_read_input_tokens ?? 0)
	)
}

function fmtTokens(n: number): string {
	return n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`
}

export function contextStatus(usage: any, messages: any[]): string {
	const tokens = totalInputTokens(usage)
	const ratio = tokens / MAX_CONTEXT
	const pct = (ratio * 100).toFixed(1)
	const color = ratio >= 0.8 ? '\x1b[31m' : ratio >= 0.5 ? '\x1b[33m' : '\x1b[32m'
	return `${color}[context] Context: ${pct}%/${fmtTokens(MAX_CONTEXT)}\x1b[0m`
}

export function estimatedContextStatus(
	systemTokens: number,
	messageTokens: number,
	messageCount: number,
): string {
	const tokens = systemTokens + messageTokens
	const ratio = tokens / MAX_CONTEXT
	const pct = (ratio * 100).toFixed(1)
	const color = ratio >= 0.8 ? '\x1b[31m' : ratio >= 0.5 ? '\x1b[33m' : '\x1b[32m'
	return `${color}[context] Context: ~${pct}%/${fmtTokens(MAX_CONTEXT)}\x1b[0m`
}

export function shouldWarn(usage: any): boolean {
	return totalInputTokens(usage) / MAX_CONTEXT >= 0.666
}

export function estimateMessageTokens(msg: any): number {
	if (typeof msg.content === 'string') return Math.ceil(msg.content.length / 4)
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
		return Math.ceil(chars / 4)
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
