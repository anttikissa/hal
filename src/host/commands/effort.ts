// /effort: the current model's effort; an alias for /model :level
// (task 7vt).

import type { SlashCommand } from '../commands.ts'
import { models } from '../models.ts'
import { effort } from '../effort.ts'
import { command as model } from './model.ts'

export const command: SlashCommand = {
	help: () => '/effort <level>: set this session\'s effort, snapped to the nearest level its model supports; default clears it. Same as /model :level.',
	complete: (args, ctx) => model.levels(ctx.model).filter((l) => l.startsWith(args)),
	describeCompletion: (args, ctx) => { let cap = effort.describe(ctx.model); return args === 'default' ? `default (${cap?.policy ?? cap?.default ?? 'provider default'})` : args },
	run(args, answers, ctx) {
		if (args) return model.run(`:${args}`, answers, ctx)
		let levels = effort.describe(ctx.model)?.levels
		return { say: `effort: ${models.qualified(ctx.model, ctx.effort)}; ${levels ? `levels: default, ${levels.join(', ')}` : 'no effort control'}` }
	},
}
