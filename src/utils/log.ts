// Structured file logger for debugging.
// Disabled by default. Enable with HAL_LOG=1 (info+error) or HAL_LOG=debug (all).
// Writes to state/hal.log in format: [ISO] [LEVEL] message {json data}
// Rotates (truncates) when file exceeds 5MB.

import { appendFileSync, statSync, writeFileSync } from 'fs'
import { STATE_DIR } from '../state.ts'

type Level = 'info' | 'error' | 'debug'
type ConfigLevel = Level | 'off' | ''

const LOG_PATH = `${STATE_DIR}/hal.log`
const MAX_SIZE = 5_000_000 // 5MB rotation threshold

const config = {
	// Defaults from HAL_LOG, but stays mutable so eval and /config can turn logging
	// on in a running server without monkey-patching this module.
	level: envLevel(process.env.HAL_LOG),
}

function envLevel(value: unknown): ConfigLevel {
	const text = String(value ?? '').toLowerCase()
	if (text === 'debug') return 'debug'
	if (text === '1' || text === 'true' || text === 'info') return 'info'
	if (text === 'error') return 'error'
	return ''
}

// Check if a given level should be logged. Read config.level at call time so eval
// patches like `log.config.level = 'debug'` take effect immediately.
function isEnabled(level: Level): boolean {
	const enabledLevel = envLevel(config.level)
	if (!enabledLevel) return false
	if (enabledLevel === 'debug') return true // debug enables everything
	if (enabledLevel === 'info') return level !== 'debug'
	return level === 'error'
}

function write(level: Level, msg: string, data?: Record<string, unknown>): void {
	if (!isEnabled(level)) return
	// Rotate if file too large (check every write — cheap stat call).
	try {
		const st = statSync(LOG_PATH)
		if (st.size > MAX_SIZE) writeFileSync(LOG_PATH, '')
	} catch {
		// File doesn't exist yet, that's fine.
	}
	const ts = new Date().toISOString()
	const dataStr = data ? ' ' + JSON.stringify(data) : ''
	const line = `[${ts}] [${level.toUpperCase()}] ${msg}${dataStr}\n`
	try {
		appendFileSync(LOG_PATH, line)
	} catch {
		// Silently fail — logging should never crash the app.
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

export const log = { config, info, error, debug, isEnabled, LOG_PATH }
