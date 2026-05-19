import { readFileSync, writeFileSync } from 'fs'
import { STATE_DIR } from '../state.ts'
import { ason } from '../utils/ason.ts'
import { log } from '../utils/log.ts'

const CLIENT_STATE_PATH = `${STATE_DIR}/client.ason`
type ClientStateFile = { lastTab: string | null; restartTab: string | null; peak: number; peakCols: number; model: string | null; doneUnseen: string[] }

function defaults(): ClientStateFile {
	return { lastTab: null, restartTab: null, peak: 0, peakCols: 0, model: null, doneUnseen: [] }
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err)
}

function isMissingFileError(err: unknown): boolean {
	return !!err && typeof err === 'object' && 'code' in err && (err as { code?: unknown }).code === 'ENOENT'
}

function load(): ClientStateFile {
	try {
		const data = ason.parse(readFileSync(CLIENT_STATE_PATH, 'utf-8')) as any
		return {
			lastTab: data?.lastTab ?? null,
			restartTab: typeof data?.restartTab === 'string' ? data.restartTab : null,
			peak: data?.peak ?? 0,
			peakCols: data?.peakCols ?? 0,
			model: data?.model ?? null,
			doneUnseen: Array.isArray(data?.doneUnseen) ? data.doneUnseen.filter((item: any) => typeof item === 'string') : [],
		}
	} catch (err) {
		if (!isMissingFileError(err)) log.error('failed to load client state', { error: errorMessage(err) })
		return defaults()
	}
}

function save(data: ClientStateFile): void {
	try {
		writeFileSync(CLIENT_STATE_PATH, ason.stringify(data) + '\n')
	} catch (err) {
		log.error('failed to save client state', { error: errorMessage(err) })
	}
}

export const clientPersistence = { load, save }
