// Context window sizes + token estimation with calibration.

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
}

const DEFAULT_CONTEXT = 200_000

export function contextWindowForModel(modelId: string): number {
	for (const [prefix, size] of Object.entries(CONTEXT_WINDOWS)) {
		if (modelId.startsWith(prefix)) return size
	}
	return DEFAULT_CONTEXT
}

// ── Calibration ──

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

export function estimateTokens(bytes: number, modelId: string): number {
	const cal = loadCalibration()[modelId]
	const ratio = cal?.bytesPerToken ?? DEFAULT_BYTES_PER_TOKEN
	return Math.ceil(bytes / ratio)
}

// ── Message byte counting ──

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
