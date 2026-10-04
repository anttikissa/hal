import type { SlashCommand } from '../commands.ts'
import { rebasePlans } from '../rebase-plans.ts'

export const command: SlashCommand = {
	help: () => '/rebase: rewrite session history with keep/drop/edit actions; the terminal opens your editor, the web opens a view. /rebase undo restores the last rewrite. Pause running work first. Earlier changes rebuild the provider cache from the changed record.',
	complete: (args) => ['undo'].filter((s) => s.startsWith(args)),
	run: (args, _answers, ctx) => {
		if (ctx.sender?.origin === 'model' || ctx.sender?.from) return { error: 'Only the human in this session may run /rebase.' }
		if (args === 'undo') return { result: rebasePlans.undo(ctx.sessionId) }
		if (args) return { error: 'Usage: /rebase [undo]' }
		return { rebase: rebasePlans.build(ctx.sessionId) }
	},
}
