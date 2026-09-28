// /pause: pauses the session's turn, as Escape does.

import type { SlashCommand } from '../commands.ts'
import { turns } from '../turns.ts'

export const command: SlashCommand = {
	run(_args, _answers, ctx) {
		let refused = turns.stop(ctx.sessionId)
		return refused === undefined ? {} : { error: refused }
	},
}
