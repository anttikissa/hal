// /redraw repaints the terminals following this session.
import type { SlashCommand } from '../commands.ts'
import { host } from '../host.ts'

export const command: SlashCommand = {
	run(_args, _answers, ctx) {
		host.broadcast(ctx.sessionId, { type: 'redraw', sessionId: ctx.sessionId })
		return {}
	},
}
