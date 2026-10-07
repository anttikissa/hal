// /model: switches the session's model; alone, opens the model picker
// on every client following the session.
// Tasks: 0x, 03, 6eq.

import type { SlashCommand } from '../commands.ts'
import { models } from '../models.ts'
import { effort } from '../effort.ts'

export const command: SlashCommand & { levels(id: string): string[] } = {
	help: () => '/model <provider/model or family>[:level]: switch this session immediately, interrupting active work and continuing safely, keeping its effort (snapped to the nearest supported level); /model :level changes only the effort; :default clears it. /model alone opens the picker (Ctrl-M too).',
	// Prefix matches first (aliases, full ids), then ids where a word of
	// the name starts with it: "fab" finds anthropic/claude-fable-5-1.
	complete: (args, ctx) => {
		let colon = args.lastIndexOf(':')
		if (colon >= 0) {
			let base = args.slice(0, colon)
			let id = base ? models.resolve(base).id : ctx.model
			return id ? command.levels(id).filter((l) => l.startsWith(args.slice(colon + 1))).map((l) => `${base}:${l}`) : []
		}
		let all = [...new Set([...models.known(), 'gpt', 'sol', 'gpt-6.1', 'gpt-6', 'claude', 'opus', 'sonnet', 'fable', 'haiku', 'astra', 'luna', 'kimi', 'qwen', 'deepseek', 'glm', 'minimax'])]
		let word = (id: string) => !id.startsWith(args) && id.split(/[/-]/).some((_, i, parts) => parts.slice(i).join('-').startsWith(args))
		let first = all.filter((id) => id.startsWith(args))
		let shown = new Set(first.map((id) => models.resolve(id).id ?? id))
		return [...(args ? [] : command.levels(ctx.model).map((l) => `:${l}`)), ...first, ...all.filter((id) => word(id) && !shown.has(id))]
	},
	describeCompletion: (args, ctx) => {
		let colon = args.lastIndexOf(':')
		if (colon < 0) { let choice = models.resolve(args); return choice.id ?? choice.login ?? args }
		let id = colon ? models.resolve(args.slice(0, colon)).id ?? args : ctx.model
		let level = args.slice(colon + 1)
		if (!level) return `effort of ${id}`
		let cap = effort.describe(id)
		return level === 'default' ? `${id}: default (${cap?.policy ?? cap?.default ?? 'provider default'})` : `${id}:${level}`
	},
	// Effort completions for `id`: default first, then its levels (task 7vt).
	levels: (id: string) => ['default', ...(effort.describe(id)?.levels ?? [])],
	run(args, _answers, ctx) {
		if (!args) return { say: `model: ${models.qualified(ctx.model, ctx.effort)}`, open: 'models' }
		// ":high" alone changes only the effort; a bare model keeps it.
		let choice = models.selection(args.startsWith(':') ? ctx.model + args : args, ctx.effort)
		if (!models.valid(choice.id)) return { error: `${args}: no such model (want provider/model; /model lists them)` }
		let previous = models.qualified(ctx.model, ctx.effort)
		let next = models.qualified(choice.id, choice.effort)
		let cap = effort.describe(choice.id)
		let fallback = cap?.policy ?? cap?.default
		let cacheChanged = ctx.model === choice.id && choice.id.startsWith('anthropic/') && (ctx.effort ?? fallback) !== (choice.effort ?? fallback)
		ctx.setModel(next)
		return { say: `${previous === next ? `model: ${next} (unchanged)` : `Model changed: ${previous} → ${next}`}${choice.note ? `; ${choice.note}` : ''}${cacheChanged ? '; changing request effort invalidates the Anthropic message cache' : ''}` }
	},
}
