// Minimal config — liveFile-backed, auto-reloads on external edits.

import { liveFile } from './live-file.ts'
import { CONFIG_PATH } from './state.ts'

export interface Config {
	defaultModel: string
	activeSessionId?: string
}

const config = liveFile<Config>(CONFIG_PATH, {
	defaults: { defaultModel: 'mock/mock-1' },
})

export function getConfig(): Config { return config }
