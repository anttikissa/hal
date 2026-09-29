import type { SlashCommand } from '../commands.ts'
import { forks } from '../forks.ts'

export const command: SlashCommand = {
	help: () => '/fork (Ctrl-B): copy this session into a new interactive tab, without stopping its turn or spending a spawn slot.',
	run(_args, _answers, ctx) {
		forks.create(ctx.sessionId)
		return {}
	},
}
