// /model: switches the session's model; alone, opens the model picker
// on every client following the session.

import type { SlashCommand } from '../commands.ts'
import { models } from '../models.ts'

export const command: SlashCommand = {
	help: () => '/model <provider/model>: switch this session to that model from its next request on. /model alone opens the picker (Ctrl-M opens it too).',
	complete: (args) => [...new Set(models.known())].filter((id) => id.startsWith(args)),
	run(args, _answers, ctx) {
		if (!args) return { say: `model: ${ctx.model}`, open: 'models' }
		if (!models.valid(args)) return { error: `${args}: no such model (want provider/model; /model lists them)` }
		ctx.setModel(args)
		return { say: `model: ${args}` }
	},
}
