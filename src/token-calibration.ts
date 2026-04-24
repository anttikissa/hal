import { STATE_DIR, ensureDir } from './state.ts'
import { liveFiles } from './utils/live-file.ts'

const DEFAULT_BYTES_PER_TOKEN = 4

export interface TokenCalibration {
	systemBytes: number
	systemTokens: number
	bytesPerToken: number
	calibratedAt: string
}

type TokenCalibrationStore = Record<string, TokenCalibration>

function stateDir(): string {
	return process.env.HAL_STATE_DIR ?? STATE_DIR
}

function calibrationFile(): TokenCalibrationStore {
	ensureDir(stateDir())
	return liveFiles.liveFile<TokenCalibrationStore>(`${stateDir()}/calibration.ason`, {}, { watch: false })
}

function modelKey(model?: string | null): string {
	return typeof model === 'string' ? model.trim() : ''
}

function get(model?: string | null): TokenCalibration | null {
	const key = modelKey(model)
	if (!key) return null
	return calibrationFile()[key] ?? null
}

function save(systemBytes: number, systemTokens: number, model?: string | null): void {
	const key = modelKey(model)
	if (!key || systemBytes <= 0 || systemTokens <= 0) return
	const store = calibrationFile()
	store[key] = {
		systemBytes,
		systemTokens,
		bytesPerToken: systemBytes / systemTokens,
		calibratedAt: new Date().toISOString(),
	}
	liveFiles.save(store)
}

function estimateTokens(bytes: number, model?: string | null): number {
	const ratio = get(model)?.bytesPerToken ?? DEFAULT_BYTES_PER_TOKEN
	return Math.ceil(Math.max(0, bytes) / ratio)
}

export const tokenCalibration = { get, save, estimateTokens }
