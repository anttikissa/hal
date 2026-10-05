// /resume lists recently closed sessions or reopens the one named, and
// shows it where this session shows (task 18c). Shift-Ctrl-T reopens
// the last closed tab without coming here.
import type { SlashCommand } from '../commands.ts'
import { host } from '../host.ts'
import { tabs } from '../tabs.ts'
import { closedSessions, sessionRow } from './tabs.ts'

const recent = 20

export const command: SlashCommand = {
	help: () => `/resume [all|session id]: list the ${recent} most recently closed sessions (all: every one), or reopen the session named.`,
	complete: (args) => ['all', ...closedSessions().map((s) => s.id)].filter((v) => v.startsWith(args)),
	run(args, _answers, ctx) {
		if (!args || args === 'all') {
			let shut = closedSessions()
			let rows = (args ? shut : shut.slice(0, recent)).map((s) => sessionRow(s, ctx.sessionId))
			if (!args && shut.length > recent) rows.push(`${shut.length - recent} more: /resume all`)
			return { say: rows.join('\n') || 'No closed sessions.' }
		}
		let outcome
		try {
			outcome = tabs.act({ type: 'tab-resume', sessionId: args })
		} catch {
			return { error: `no session ${args}` }
		}
		if (outcome.refused) return { error: outcome.refused }
		host.broadcast(ctx.sessionId, { type: 'go', sessionId: ctx.sessionId, tab: outcome.tab! })
		return { say: `reopened ${outcome.tab}` }
	},
}
