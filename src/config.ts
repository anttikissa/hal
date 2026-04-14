// Runtime configuration — loads config.ason and applies overrides to module
// config objects. Importing this module must stay cheap: no file I/O, no
// watcher setup, no render invalidation. That all lives behind init().

import { liveFiles } from './utils/live-file.ts'
import { client } from './client.ts'
import { blocks } from './cli/blocks.ts'
import { prompt } from './cli/prompt.ts'
import { render } from './client/render.ts'
import { agentLoop } from './runtime/agent-loop.ts'
import { memory } from './memory.ts'
import { models } from './models.ts'
import { anthropicUsage } from './anthropic-usage.ts'
import { openaiUsage } from './openai-usage.ts'
import { subscriptionUsage } from './subscription-usage.ts'

// Module name → config object. Add new modules here as they gain configs.
const modules: Record<string, Record<string, any>> = {
	client: client.config,
	blocks: blocks.config,
	prompt: prompt.config,
	render: render.config,
	agentLoop: agentLoop.config,
	memory: memory.config,
	models: models.config,
	subscriptionUsage: subscriptionUsage.config,
	anthropicUsage: anthropicUsage.config,
	openaiUsage: openaiUsage.config,
}

// config.ason lives at repo root — it's user-facing config.
const HAL_DIR = import.meta.dir.replace(/\/src$/, '')
const CONFIG_PATH = `${HAL_DIR}/config.ason`

const state = {
	initialized: false,
}

function apply(): void {
	for (const [name, overrides] of Object.entries(config.data)) {
		const target = config.modules[name]
		if (target && overrides && typeof overrides === 'object') {
			Object.assign(target, overrides)
		}
	}
}

function init(): void {
	if (state.initialized) return
	state.initialized = true

	// liveFile() does the real disk load and starts the watcher. Keeping that here
	// makes importing config.ts side-effect free.
	config.data = liveFiles.liveFile(CONFIG_PATH, {}) as Record<string, any>
	config.apply()
	liveFiles.onChange(config.data, () => {
		config.apply()
		render.invalidateHistoryCache()
		client.requestRender(false)
	})
}

function save(): void {
	// Saving before init would write a plain empty object instead of the watched
	// live-file proxy. Explicit calls may initialize; imports may not.
	if (!config.state.initialized) config.init()
	liveFiles.save(config.data)
}

export const config = {
	state,
	modules,
	data: {} as Record<string, any>,
	init,
	apply,
	save,
}
