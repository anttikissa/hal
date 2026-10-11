// /kill [#n]: stops one of this session's background Bash jobs, named by
// its call block (#123 or #t123); without one, the only job running.
// The session gets the job's result, marked stopped by the user.
import type { SlashCommand } from '../commands.ts'
import { jobs } from '../jobs.ts'

export const command: SlashCommand = {
	help: () => '/kill [#t123|all]: stop one background command here, or all of them. Without an argument, stop the only running job. Retains output; does not stop the agent or subagents. Stopping does not undo external effects.',
	complete: (args, ctx) => ['all', ...jobs.running(ctx.sessionId).map((id) => jobs.label(ctx.sessionId, id))].filter((v) => v.startsWith(args)),
	run(args, _answers, ctx) {
		let { refused, stopped } = jobs.stop(ctx.sessionId, args)
		return refused ? { error: refused } : { say: `stopped background job ${stopped}` }
	},
}
