// /compact: summarises the session's context so far (task bc), without
// a model call; the transcript stays whole.

import type { SlashCommand } from '../commands.ts'
import { states } from '../../common/states.ts'
import { compact } from '../compact.ts'
import { status } from '../status.ts'

export const command: SlashCommand = {
	help: () => '/compact: replace the context so far with a short summary (first and last prompts, the answers to them); the model can read the full history file. Only while the session is idle.',
	run(_args, _answers, ctx) {
		if (states.busy(status.stateOf(ctx.sessionId))) return { error: 'the session is busy; /compact when the turn is done' }
		return compact.run(ctx.sessionId) === undefined ? { say: 'nothing to compact' } : {}
	},
}
