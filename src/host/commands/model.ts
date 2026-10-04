// /model: switches the session's model; alone, opens the model picker
// on every client following the session.

import type { SlashCommand } from '../commands.ts'
import { models } from '../models.ts'
import { effort } from '../effort.ts'

export const command: SlashCommand = {
	help: () => '/model <provider/model or family>[:level]: switch this session from its next request; :default clears effort. /model alone opens the picker (Ctrl-M too).',
	// Prefix matches first (aliases, full ids), then ids where a word of
	// the name starts with it: "fab" finds anthropic/claude-fable-5-1.
	complete: (args) => {
		let all = [...new Set([...models.known(), 'gpt', 'sol', 'gpt-6.1', 'gpt-6', 'claude', 'opus', 'sonnet', 'fable', 'haiku', 'astra', 'luna', 'kimi', 'qwen', 'deepseek', 'glm', 'minimax'])]
		let word = (id: string) => !id.startsWith(args) && id.split(/[/-]/).some((_, i, parts) => parts.slice(i).join('-').startsWith(args))
		let first = all.filter((id) => id.startsWith(args))
		let shown = new Set(first.map((id) => models.resolve(id).id ?? id))
		return [...first, ...all.filter((id) => word(id) && !shown.has(id))]
	},
	describeCompletion: (args) => { let choice = models.resolve(args); return choice.id ?? choice.login ?? args },
	run(args, _answers, ctx) {
		if (!args) return { say: `model: ${models.qualified(ctx.model, ctx.effort)}`, open: 'models' }
		let choice = models.selection(args)
		if (!models.valid(choice.id)) return { error: `${args}: no such model (want provider/model; /model lists them)` }
		let previous = models.qualified(ctx.model, ctx.effort)
		let next = models.qualified(choice.id, choice.effort)
		let cap = effort.describe(choice.id)
		let fallback = cap?.policy ?? cap?.default
		let cacheChanged = ctx.model === choice.id && choice.id.startsWith('anthropic/') && (ctx.effort ?? fallback) !== (choice.effort ?? fallback)
		ctx.setModel(next)
		return { say: `${previous === next ? `model: ${next} (unchanged)` : `Model changed: ${previous} → ${next}`}${cacheChanged ? '; changing request effort invalidates the Anthropic message cache' : ''}` }
	},
}
