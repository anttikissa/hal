// Show or set the session's automatic tab closure policy.
// Tasks: p87.
import type { SlashCommand } from '../commands.ts'
import { autoclose } from '../autoclose.ts'
import { sessions } from '../sessions.ts'

export const command: SlashCommand = {
	help: () => '/autoclose [on|off]: show or set automatic tab closure after a successful final turn with no work left. Questions, failed and paused turns stay open; human steering turns autoclose off.',
	complete: (args) => ['on', 'off'].filter((value) => value.startsWith(args)),
	run(args, _answers, ctx) {
		if (!args) return { say: `Autoclose: ${sessions.open(ctx.sessionId).autoclose ? 'on' : 'off'}` }
		if (args !== 'on' && args !== 'off') return { error: 'usage: /autoclose [on|off]' }
		let value = args === 'on'
		if ((sessions.open(ctx.sessionId).autoclose ?? false) === value) return { say: `Autoclose: ${args}` }
		autoclose.set(ctx.sessionId, value)
		return {}
	},
}
