// Minimal config — watched file with defaults.

import { readFileSync, watch } from 'fs'
import { parse } from './utils/ason.ts'
import { CONFIG_PATH } from './state.ts'

export interface Config {
	defaultModel: string
	activeSessionId?: string
}

const DEFAULTS: Config = {
	defaultModel: 'mock/mock-1',
}

let _config: Config | null = null
try { watch(CONFIG_PATH, () => { _config = null }) } catch {}

export function getConfig(): Config {
	if (_config) return _config
	try {
		const raw = readFileSync(CONFIG_PATH, 'utf-8')
		_config = { ...DEFAULTS, ...(parse(raw) as Record<string, unknown>) }
	} catch {
		_config = { ...DEFAULTS }
	}
	return _config
}
