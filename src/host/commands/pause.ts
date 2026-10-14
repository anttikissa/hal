// /pause: pauses the session's turn, as Escape does.

import type { SlashCommand } from '../commands.ts'
import { work } from '../work.ts'

export const command: SlashCommand = {
	quiet: true,
	run(_args, _answers, ctx) {
		let refused = work.pause(ctx.sessionId)
		return refused === undefined ? {} : { error: refused }
	},
}
