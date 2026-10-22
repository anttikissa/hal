// /compact asks the current model for a checkpoint; undo restores prior context.
import type { SlashCommand } from '../commands.ts'
import { contextTransitions } from '../context-transitions.ts'
import { compact } from '../compact.ts'
import { history } from '../history.ts'
import { prompts } from '../prompts.ts'
import { turns } from '../turns.ts'

export const command: SlashCommand = {
	help: () =>
		'/compact [focus]: ask the current model to write a working-state checkpoint with COMPACT after active work settles. Full history stays; Escape pauses preparation. Optional focus guides the checkpoint.\n/compact undo: restore the context the latest compaction summarized, keeping later work; /rebase undo reverses it.',
	complete: (args) => ['undo'].filter((s) => s.startsWith(args)),
	run: (args, _answers, ctx) => {
		if (args.trim() === 'undo') return contextTransitions.undo(ctx.sessionId, 'compact', ctx.sender)
		if (ctx.sender?.origin === 'model')
			return { error: 'Use COMPACT { summary: "your working-state handoff" } directly.' }
		if (contextTransitions.pending(ctx.sessionId))
			return { error: 'a context transition is already pending; wait or press Escape' }
		if (!compact.anything(history.readSync(ctx.sessionId))) return { say: 'nothing to compact' }
		let error = prompts.submit(
			ctx.sessionId,
			`The user requested context compaction. Use COMPACT with a concise working-state handoff before further substantial work. Preserve unresolved requirements, findings, decisions, work and verification state, and a consistent next action. Then resume unfinished work; if it is complete, acknowledge and wait.${args.trim() ? `\nFocus: ${args.trim()}` : ''}`,
			undefined,
			turns.state.running.has(ctx.sessionId) ? 'soft-steer' : 'steer',
			{ ...ctx.sender, origin: 'model', generatingCommand: 'compact' },
		)
		return error ? { error } : { result: 'Checkpoint requested from the current model.' }
	},
}
