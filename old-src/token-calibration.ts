import { readFile, writeFile } from 'fs/promises'
import { stringify, parse } from './utils/ason.ts'
import { CALIBRATION_FILE } from './state.ts'

export interface TokenCalibration {
	systemBytes: number
	systemTokens: number
	bytesPerToken: number
	calibratedAt: string
}

type TokenCalibrationStore = Record<string, TokenCalibration>

const DEFAULT_BYTES_PER_TOKEN = 4
const calibratedModels = new Set<string>()
let calibrationWriteLock: Promise<void> = Promise.resolve()

function modelKey(model?: string | null): string {
	return typeof model === 'string' ? model.trim() : ''
}

async function readCalibrationStore(): Promise<TokenCalibrationStore> {
	try {
		const raw = parse(await readFile(CALIBRATION_FILE, 'utf-8'))
		return raw && typeof raw === 'object' && !Array.isArray(raw)
			? (raw as unknown as TokenCalibrationStore)
			: {}
	} catch {
		return {}
	}
}

export async function getTokenCalibration(model?: string | null): Promise<TokenCalibration | null> {
	const store = await readCalibrationStore()
	const key = modelKey(model)
	if (!key) return null
	return store[key] ?? null
}

export async function saveTokenCalibration(
	systemBytes: number,
	systemTokens: number,
	model?: string | null,
): Promise<void> {
	const doWrite = async () => {
		const cal: TokenCalibration = {
			systemBytes,
			systemTokens,
			bytesPerToken: systemBytes / systemTokens,
			calibratedAt: new Date().toISOString(),
		}

		const store = await readCalibrationStore()
		const key = modelKey(model)
		if (!key) return
		await writeFile(CALIBRATION_FILE, stringify({ ...store, [key]: cal }) + '\n')
	}

	calibrationWriteLock = calibrationWriteLock.then(doWrite, doWrite)
	await calibrationWriteLock
}

export function isModelCalibrated(model: string | null): boolean {
	const key = modelKey(model)
	return key.length > 0 && calibratedModels.has(key)
}

export function markModelCalibrated(model: string | null): void {
	const key = modelKey(model)
	if (!key) return
	calibratedModels.add(key)
}

export function estimateTokensSync(bytes: number, calibration: TokenCalibration | null): number {
	const ratio = calibration?.bytesPerToken ?? DEFAULT_BYTES_PER_TOKEN
	return Math.ceil(bytes / ratio)
}
