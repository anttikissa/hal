// Structured file logger for debugging.
// Disabled by default. Enable with HAL_LOG=1 (info+error) or HAL_LOG=debug (all).
// Writes to state/hal.log in format: [ISO] [LEVEL] message {json data}
// Rotates (truncates) when file exceeds 1MB.

import { appendFileSync, statSync, writeFileSync } from 'fs'
import { STATE_DIR } from '../state.ts'

type Level = 'info' | 'error' | 'debug'

const LOG_PATH = `${STATE_DIR}/hal.log`
const MAX_SIZE = 1_000_000 // 1MB rotation threshold

// HAL_LOG=1 enables info+error, HAL_LOG=debug enables all levels
const envVal = (process.env.HAL_LOG ?? '').toLowerCase()
const enabledLevel: Level | null =
	envVal === 'debug' ? 'debug' :
		envVal === '1' || envVal === 'true' || envVal === 'info' ? 'info' :
			null

// Check if a given level should be logged
function isEnabled(level: Level): boolean {
	if (!enabledLevel) return false
	if (enabledLevel === 'debug') return true // debug enables everything
	if (level === 'debug') return false        // info mode skips debug
	return true
}

function write(level: Level, msg: string, data?: Record<string, unknown>): void {
	if (!isEnabled(level)) return
	// Rotate if file too large (check every write — cheap stat call)
	try {
		const st = statSync(LOG_PATH)
		if (st.size > MAX_SIZE) writeFileSync(LOG_PATH, '')
	} catch {
		// File doesn't exist yet, that's fine
	}
	const ts = new Date().toISOString()
	const dataStr = data ? ' ' + JSON.stringify(data) : ''
	const line = `[${ts}] [${level.toUpperCase()}] ${msg}${dataStr}\n`
	try {
		appendFileSync(LOG_PATH, line)
	} catch {
		// Silently fail — logging should never crash the app
	}
}

function info(msg: string, data?: Record<string, unknown>): void {
	write('info', msg, data)
}

function error(msg: string, data?: Record<string, unknown>): void {
	write('error', msg, data)
}

function debug(msg: string, data?: Record<string, unknown>): void {
	write('debug', msg, data)
}

export const log = { info, error, debug, isEnabled, LOG_PATH }
