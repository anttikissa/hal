// Minimal config — liveFile-backed, auto-reloads on external edits.

import { liveFiles } from './utils/live-file.ts'
import { CONFIG_PATH } from './state.ts'

export type PermissionLevel = 'yolo' | 'ask-writes' | 'ask-all'

export interface Config {
	defaultModel: string
	permissions?: PermissionLevel
	eval?: boolean
}

let _config: Config | null = null

export function getConfig(): Config {
	if (!_config) {
		_config = liveFiles.liveFile<Config>(process.env.HAL_CONFIG ?? CONFIG_PATH, {
			defaults: { defaultModel: 'anthropic/claude-opus-4-6' },
		})
	}
	return _config
}

export const config = { getConfig }
