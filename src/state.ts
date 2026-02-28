import { mkdirSync, existsSync } from 'fs'
import { resolve } from 'path'

export const HAL_DIR = process.env.HAL_DIR ? resolve(process.env.HAL_DIR) : process.cwd()
export const LAUNCH_CWD = process.env.LAUNCH_CWD ? resolve(process.env.LAUNCH_CWD) : process.cwd()

export const STATE_DIR = process.env.HAL_STATE_DIR
	? resolve(process.env.HAL_STATE_DIR)
	: `${HAL_DIR}/state`
export const IPC_DIR = `${STATE_DIR}/ipc`
export const SESSIONS_DIR = `${STATE_DIR}/sessions`
export const SESSIONS_INDEX = `${SESSIONS_DIR}/index.ason`
export const CALIBRATION_FILE = `${STATE_DIR}/calibration.ason`
export const MODELS_FILE = `${STATE_DIR}/models.ason`
export const TOOL_LOG = `${STATE_DIR}/tool-calls.asonl`
export const RESPONSE_LOG = `${STATE_DIR}/responses.asonl`

export function sessionDir(id: string): string {
	return `${SESSIONS_DIR}/${id}`
}

export function ensureStateDir(): void {
	for (const dir of [STATE_DIR, IPC_DIR, SESSIONS_DIR]) {
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
	}
}
