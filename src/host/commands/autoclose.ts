// Show or set the session's automatic tab closure policy.
// Tasks: p87.
import type { SlashCommand } from '../commands.ts'
import { autoclose } from '../autoclose.ts'
import { sessions } from '../sessions.ts'

export const command: SlashCommand = {
	help: () => '/autoclose [on|off]: show or set automatic tab closure after a successful final turn with no work left. Questions, failed and paused turns stay open; human steering turns autoclose off.',
	complete: (args) => ['on', 'off'].filter((value) => value.startsWith(args)),
	run(args, _answers, ctx) {
		if (!args) return { say: sessions.open(ctx.sessionId).autoclose ? 'on' : 'off' }
		let value = ['on', 'true', '1', 'yes', 'y'].includes(args) ? true : ['off', 'false', '0', 'no', 'n'].includes(args) ? false : undefined
		if (value === undefined) return { error: 'usage: /autoclose [on|off]' }
		if ((sessions.open(ctx.sessionId).autoclose ?? false) === value) return { say: value ? 'on' : 'off' }
		autoclose.set(ctx.sessionId, value, true)
		return {}
	},
}
