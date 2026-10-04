import type { SlashCommand } from '../commands.ts'
import { recap } from '../recap.ts'
import { tabs } from '../tabs.ts'

export const command: SlashCommand = {
	help: () => '/recap [tab number|name|session id|all]: recall the goal, progress and blockers in at most 400 characters per session. Runs in the background without interrupting any turn; all lists other open tabs. Automatic recaps on return after 3 minutes can be disabled with /config sessionRecap false.',
	async run(args, _answers, ctx) {
		let ids = recap.targets(args, ctx.sessionId)
		let lines = await Promise.all(ids.map(async (id) => `Recap: ${args ? `${tabs.label(id)}: ` : ''}${await recap.summary(id)}`))
		return { say: lines.join('\n') || 'No other open tabs.' }
	},
}
