// /clear: a fresh context in the same tab (task vh). The model starts
// over with the same system prompt, cwd and model; the transcript, the
// draft, the name and the tab stay.

import type { SlashCommand } from '../commands.ts'
import { states } from '../../common/states.ts'
import { compact } from '../compact.ts'
import { status } from '../status.ts'

export const command: SlashCommand = {
	help: () => '/clear: start the model on a fresh context in this tab; the transcript stays on screen. Only while the session is idle.',
	run(_args, _answers, ctx) {
		if (states.busy(status.stateOf(ctx.sessionId))) return { error: 'the session is busy; /clear when the turn is done' }
		return compact.reset(ctx.sessionId) ? {} : { say: 'the context is already empty' }
	},
}
