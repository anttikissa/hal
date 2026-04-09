// Runtime configuration — loads config.ason and applies overrides to module
// config objects. The exported namespace stays mutable so tests and eval can
// swap the backing data object or patch save/apply behavior.

import { liveFiles } from './utils/live-file.ts'
import { client } from './client.ts'
import { blocks } from './cli/blocks.ts'
import { prompt } from './cli/prompt.ts'
import { agentLoop } from './runtime/agent-loop.ts'

// Module name → config object. Add new modules here as they gain configs.
const modules: Record<string, Record<string, any>> = {
	client: client.config,
	blocks: blocks.config,
	prompt: prompt.config,
	agentLoop: agentLoop.config,
}

// config.ason lives at repo root — it's user-facing config.
const HAL_DIR = import.meta.dir.replace(/\/src$/, '')

function apply(): void {
	for (const [name, overrides] of Object.entries(config.data)) {
		const target = config.modules[name]
		if (target && overrides && typeof overrides === 'object') {
			Object.assign(target, overrides)
		}
	}
}

function save(): void {
	liveFiles.save(config.data)
}

export const config = {
	modules,
	data: liveFiles.liveFile(`${HAL_DIR}/config.ason`, {}) as Record<string, any>,
	apply,
	save,
}

// Apply on load and on every external edit.
config.apply()
liveFiles.onChange(config.data, config.apply)
