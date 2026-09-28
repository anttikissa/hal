// /broadcast sends from this session to every other open tab.
import type { SlashCommand } from '../commands.ts'
import { host } from '../host.ts'
import { prompts } from '../prompts.ts'
import { tabs } from '../tabs.ts'

export const command: SlashCommand = {
	help: () => '/broadcast <message>: send a prompt or command to every other open session. /send all <message> is an alias.',
	async run(args, _answers, ctx) {
		let text = args.trim()
		if (!text) return { error: 'usage: /broadcast <message>' }
		let targets = [...new Set(tabs.file().open.filter((id) => id !== ctx.sessionId))]
		if (!targets.length) return { say: 'no other open sessions' }
		let sent = 0
		let refused: string[] = []
		for (let id of targets) {
			await (host.ready(id) ?? Promise.resolve())
			let why = prompts.submit(id, text, undefined, false, { from: ctx.sessionId, label: tabs.label(ctx.sessionId) })
			if (why) refused.push(`${tabs.label(id)}: ${why}`)
			else sent++
		}
		return refused.length ? { error: `sent to ${sent} session${sent === 1 ? '' : 's'}; ${refused.join('; ')}` } : { say: `sent to ${sent} session${sent === 1 ? '' : 's'}` }
	},
}
