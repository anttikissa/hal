// Context window sizes + token estimation with calibration.
//
// ── Token estimation ──
//
// estimateTokens / messageBytes exist ONLY to give a rough context %
// for fresh/idle tabs that have never made an API call. Once the API
// responds, its usage.input is the ground truth and replaces any estimate.
// Do NOT use estimates for autocompact decisions — those use real counts only.

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { parse, stringify } from '../utils/ason.ts'
import { STATE_DIR } from '../state.ts'

// ── Context windows ──

const CONTEXT_WINDOWS: Record<string, number> = {
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
}

const DEFAULT_CONTEXT = 200_000

export function contextWindowForModel(modelId: string): number {
	for (const [prefix, size] of Object.entries(CONTEXT_WINDOWS)) {
		if (modelId.startsWith(prefix)) return size
	}
	return DEFAULT_CONTEXT
}

// ── Calibration ──
// Calibration learns the bytes→tokens ratio from real API responses.
// This improves the accuracy of estimates for fresh tabs.

const DEFAULT_BYTES_PER_TOKEN = 4

interface Calibration { bytesPerToken: number; calibratedAt: string }

const calibrationPath = () => `${STATE_DIR}/calibration.ason`
let calibrationCache: Record<string, Calibration> | null = null

function loadCalibration(): Record<string, Calibration> {
	if (calibrationCache) return calibrationCache
	const p = calibrationPath()
	if (!existsSync(p)) { calibrationCache = {}; return calibrationCache }
	try { calibrationCache = parse(readFileSync(p, 'utf-8')) as any } catch { calibrationCache = {} }
	return calibrationCache!
}

export function saveCalibration(modelId: string, totalBytes: number, totalTokens: number): void {
	if (totalTokens <= 0 || totalBytes <= 0) return
	const store = loadCalibration()
	store[modelId] = { bytesPerToken: totalBytes / totalTokens, calibratedAt: new Date().toISOString() }
	calibrationCache = store
	writeFileSync(calibrationPath(), stringify(store) + '\n')
}

export function isCalibrated(modelId: string): boolean {
	return modelId in loadCalibration()
}

// Estimate token count from byte count. Used ONLY for fresh-tab UI display.
export function estimateTokens(bytes: number, modelId: string): number {
	const cal = loadCalibration()[modelId]
	const ratio = cal?.bytesPerToken ?? DEFAULT_BYTES_PER_TOKEN
	return Math.ceil(bytes / ratio)
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

// Estimate context for a set of API messages. Returns { used, max, estimated: true }.
// Used ONLY for fresh-tab UI display before the first API response.
export function estimateContext(
	apiMessages: any[],
	modelId: string,
): { used: number; max: number; estimated: true } {
	let totalBytes = 0
	for (const msg of apiMessages) totalBytes += messageBytes(msg)
	const max = contextWindowForModel(modelId)
	return { used: estimateTokens(totalBytes, modelId), max, estimated: true as const }
}