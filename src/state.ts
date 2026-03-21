import { mkdirSync, existsSync } from 'fs'
import { resolve } from 'path'

export const HAL_DIR = process.env.HAL_DIR ?? resolve(import.meta.dir, '..')
export const STATE_DIR = process.env.HAL_STATE_DIR ?? `${HAL_DIR}/state`
export const IPC_DIR = `${STATE_DIR}/ipc`

export function ensureDir(dir: string): void {
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

export function ensureStateDir(): void {
	ensureDir(STATE_DIR)
	ensureDir(IPC_DIR)
}
