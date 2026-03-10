// Token calibration store (bytes → tokens), learned from real API usage.
//
// Purpose:
// - Improve pre-API context estimates shown in the status line.
// - Never replace real usage once the provider reports usage.input.

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { ason } from '../utils/ason.ts'
import { STATE_DIR } from '../state.ts'

export interface TokenCalibration {
	bytesPerToken: number
	calibratedAt: string
}

type CalibrationStore = Record<string, TokenCalibration>

const DEFAULT_BYTES_PER_TOKEN = 4
const calibrationPath = () => `${STATE_DIR}/calibration.ason`
let calibrationCache: CalibrationStore | null = null

function loadStore(): CalibrationStore {
	if (calibrationCache) return calibrationCache
	const path = calibrationPath()
	if (!existsSync(path)) {
		calibrationCache = {}
		return calibrationCache
	}
	try {
		calibrationCache = ason.parse(readFileSync(path, 'utf-8')) as CalibrationStore
	} catch {
		calibrationCache = {}
	}
	return calibrationCache
}

export function saveTokenCalibration(modelId: string, totalBytes: number, totalTokens: number): void {
	if (!modelId || totalBytes <= 0 || totalTokens <= 0) return
	const store = loadStore()
	store[modelId] = {
		bytesPerToken: totalBytes / totalTokens,
		calibratedAt: new Date().toISOString(),
	}
	calibrationCache = store
	writeFileSync(calibrationPath(), ason.stringify(store) + '\n')
}

export function isModelCalibrated(modelId: string): boolean {
	return !!modelId && modelId in loadStore()
}

export function estimateTokensSync(bytes: number, modelId: string): number {
	const ratio = loadStore()[modelId]?.bytesPerToken ?? DEFAULT_BYTES_PER_TOKEN
	return Math.ceil(bytes / ratio)
}

export const tokenCalibration = {
	saveTokenCalibration,
	isModelCalibrated,
	estimateTokensSync,
}
