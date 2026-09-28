import type { SlashCommand } from '../commands.ts'
import { statusUsage } from '../status-usage.ts'

export const command: SlashCommand = {
	help: () => '/status: show usage windows for every account and their local reset times.',
	async run(args, _answers, ctx) {
		if (args) return { error: 'usage: /status' }
		return { say: await statusUsage.show(ctx.sessionId, ctx.model) }
	},
}
