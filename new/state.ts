import { mkdirSync, existsSync } from 'fs'
import { resolve } from 'path'

export const HAL_DIR = process.env.HAL_DIR ? resolve(process.env.HAL_DIR) : resolve(import.meta.dir, '..')
export const LAUNCH_CWD = process.env.LAUNCH_CWD ? resolve(process.env.LAUNCH_CWD) : process.cwd()

export const STATE_DIR = process.env.HAL_STATE_DIR
	? resolve(process.env.HAL_STATE_DIR)
	: `${HAL_DIR}/new-state`
export const IPC_DIR = `${STATE_DIR}/ipc`
export const SESSIONS_DIR = `${STATE_DIR}/sessions`
export const CONFIG_PATH = `${STATE_DIR}/config.ason`
export const EPOCH_PATH = `${STATE_DIR}/epoch.txt`

export function sessionDir(id: string): string {
	return `${SESSIONS_DIR}/${id}`
}

export function ensureDir(dir: string): void {
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

export function ensureStateDir(): void {
	for (const dir of [STATE_DIR, IPC_DIR, SESSIONS_DIR]) ensureDir(dir)
}
