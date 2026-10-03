// /model: switches the session's model; alone, opens the model picker
// on every client following the session.

import type { SlashCommand } from '../commands.ts'
import { models } from '../models.ts'

export const command: SlashCommand = {
	help: () => '/model <provider/model or family>[:level]: switch this session from its next request; :default clears effort. /model alone opens the picker (Ctrl-M too).',
	complete: (args) => [...new Set([...models.known(), 'gpt', 'sol', 'gpt-6.1', 'gpt-6', 'claude', 'opus', 'sonnet', 'fable', 'haiku', 'astra', 'luna', 'kimi', 'qwen', 'deepseek', 'glm', 'minimax'])].filter((id) => id.startsWith(args)),
	describeCompletion: (args) => { let choice = models.resolve(args); return choice.id ?? choice.login ?? args },
	run(args, _answers, ctx) {
		if (!args) return { say: `model: ${models.qualified(ctx.model, ctx.effort)}`, open: 'models' }
		let choice = models.selection(args)
		if (!models.valid(choice.id)) return { error: `${args}: no such model (want provider/model; /model lists them)` }
		let previous = models.qualified(ctx.model, ctx.effort)
		let next = models.qualified(choice.id, choice.effort)
		ctx.setModel(next)
		return { say: `${previous === next ? `model: ${next} (unchanged)` : `Model changed: ${previous} → ${next}`}${choice.id.startsWith('anthropic/') && ctx.effort !== choice.effort ? '; changing request effort restarts the Anthropic cache prefix' : ''}` }
	},
}
