// /model: switches the session's model; alone, opens the model picker
// on every client following the session.

import type { SlashCommand } from '../commands.ts'
import { models } from '../models.ts'

export const command: SlashCommand = {
	help: () => '/model <provider/model or family>: switch this session from its next request; /model alone opens the picker (Ctrl-M too).',
	complete: (args) => [...new Set([...models.known(), 'gpt', 'claude', 'opus', 'kimi', 'qwen', 'deepseek', 'glm', 'minimax'])].filter((id) => id.startsWith(args)),
	run(args, _answers, ctx) {
		if (!args) return { say: `model: ${ctx.model}`, open: 'models' }
		let choice = models.resolve(args)
		if (!choice.id) return { error: `${args}: no access; ${choice.login} to use it` }
		if (!models.valid(choice.id)) return { error: `${args}: no such model (want provider/model; /model lists them)` }
		ctx.setModel(choice.id)
		return { say: `model: ${choice.id}` }
	},
}
