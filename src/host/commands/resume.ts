// /resume reopens the last closed tab, or the session named, and shows
// it where this session shows. Shift-Ctrl-T does the same unrecorded.
import type { SlashCommand } from '../commands.ts'
import { host } from '../host.ts'
import { tabs } from '../tabs.ts'

export const command: SlashCommand = {
	help: () => '/resume [session id]: reopen the last closed tab, or the session named.',
	run(args, _answers, ctx) {
		let outcome
		try {
			outcome = tabs.act({ type: 'tab-resume', ...(args && { sessionId: args }) })
		} catch {
			return { error: `no session ${args}` }
		}
		if (outcome.refused) return { error: outcome.refused }
		host.broadcast(ctx.sessionId, { type: 'go', sessionId: ctx.sessionId, tab: outcome.tab! })
		return { say: `reopened ${outcome.tab}` }
	},
}
