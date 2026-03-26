// Runtime configuration — loads state/config.ason and applies overrides
// to each module's config object. Watches for changes.
//
// config.ason format:
//   {
//     client: { backgroundLoadTabs: false }
//     blocks: { blobBatchSize: 16 }
//   }
//
// Each key maps to a module, values are Object.assign'd onto module.config.

import { liveFiles } from './utils/live-file.ts'
import { client } from './client.ts'
import { blocks } from './cli/blocks.ts'
import { prompt } from './cli/prompt.ts'

// Module name → config object. Add new modules here as they gain configs.
const modules: Record<string, Record<string, any>> = {
	client: client.config,
	blocks: blocks.config,
	prompt: prompt.config,
}

// config.ason lives at project root (not state/) — it's user-facing config
const HAL_DIR = import.meta.dir.replace(/\/src$/, '')
const data = liveFiles.liveFile(`${HAL_DIR}/config.ason`, {})

function apply(): void {
	for (const [name, overrides] of Object.entries(data)) {
		const target = modules[name]
		if (target && overrides && typeof overrides === 'object') {
			Object.assign(target, overrides)
		}
	}
}

// Apply on load and on every external edit
apply()
liveFiles.onChange(data, apply)

export const config = { data, apply }
