import { mkdirSync, existsSync } from 'fs'
import { resolve } from 'path'

const HAL_DIR = process.env.HAL_DIR ?? resolve(import.meta.dir, '..')
const STATE_DIR = process.env.HAL_STATE_DIR ?? `${HAL_DIR}/state`
const IPC_DIR = `${STATE_DIR}/ipc`

function ensureDir(dir: string): void {
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function ensureStateDir(): void {
	ensureDir(STATE_DIR)
	ensureDir(IPC_DIR)
}

export { HAL_DIR, STATE_DIR, IPC_DIR, ensureDir, ensureStateDir }
