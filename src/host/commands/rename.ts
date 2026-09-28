// /rename names the session for all clients, or clears its name.
import type { SlashCommand } from '../commands.ts'

export const command: SlashCommand = {
	help: () => '/rename <name>: set the session name (one line, at most 60 characters). /rename alone clears it.',
	run(args, _answers, ctx) {
		let name = args.trim()
		if (/[\r\n]/.test(name)) return { error: 'session name must be one line' }
		if (name.length > 60) return { error: 'session name must be at most 60 characters' }
		ctx.setName!(name || undefined)
		return { say: name ? `session name: ${name}` : 'session name cleared' }
	},
}
