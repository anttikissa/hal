import { mkdirSync, existsSync, mkdtempSync } from 'fs'
import { resolve, join } from 'path'
import { tmpdir } from 'os'

export const NEW_DIR = resolve(import.meta.dir)
export const HAL_DIR = process.env.HAL_DIR ? resolve(process.env.HAL_DIR) : resolve(NEW_DIR, '..')
export const LAUNCH_CWD = process.env.LAUNCH_CWD ? resolve(process.env.LAUNCH_CWD) : process.cwd()

function resolveStateDir(): string {
	if (process.env.HAL_STATE_DIR) return resolve(process.env.HAL_STATE_DIR)
	if (process.env.NODE_ENV === 'test') {
		const dir = mkdtempSync(join(tmpdir(), `hal-test-${process.pid}-`))
		process.env.HAL_STATE_DIR = dir
		return resolve(dir)
	}
	return `${HAL_DIR}/state`
}

export const STATE_DIR = resolveStateDir()
export const IPC_DIR = `${STATE_DIR}/ipc`
export const SESSIONS_DIR = `${STATE_DIR}/sessions`
export const CONFIG_PATH = `${HAL_DIR}/config.ason`
export const CLIENT_STATE_PATH = `${STATE_DIR}/client.ason`
export const EPOCH_PATH = `${STATE_DIR}/epoch.txt`

export function sessionDir(id: string): string {
	return `${SESSIONS_DIR}/${id}`
}

export function blobsDir(id: string): string {
	return `${SESSIONS_DIR}/${id}/blobs`
}

export function ensureDir(dir: string): void {
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

export function ensureStateDir(): void {
	for (const dir of [STATE_DIR, IPC_DIR, SESSIONS_DIR]) ensureDir(dir)
}

export const state = { sessionDir, blobsDir, ensureDir, ensureStateDir }
