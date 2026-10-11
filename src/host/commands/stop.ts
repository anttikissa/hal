import type { SlashCommand } from '../commands.ts'
import { work } from '../work.ts'

export const command: SlashCommand = {
	help: () => '/stop <session-id|#t123>: stop this execution and its owned work recursively, retaining sessions and output. Bare numbers mean local tool calls, not tabs. Unlike Esc, this stops subagents too. Stopping may leave partial external changes, including commands flagged unsafe to stop.',
	run(args, _answers, ctx) {
		return { say: work.stop(work.target(ctx.sessionId, args)) }
	},
}
