// /resume lists recently closed sessions or reopens the one named, and
// shows it where this session shows (task 18c). Shift-Ctrl-T reopens
// the last closed tab without coming here.
import type { SlashCommand } from '../commands.ts'
import { host } from '../host.ts'
import { tabs } from '../tabs.ts'
import { closedSessions, sessionRow } from './tabs.ts'

const recent = 20

export const command: SlashCommand = {
	quiet: true,
	help: () =>
		`/resume --bg <session id> reopens a session without changing focus in any client. Use --bg last for the most recently closed one.\n/resume lists the ${recent} most recently closed sessions.\n/resume all lists every closed session.\n/resume last reopens and shows the most recently closed one (Shift-Ctrl-T).\n/resume <session id> reopens and shows the session named.`,
	complete(args) {
		let bg = args.startsWith('--bg ')
		let prefix = bg ? '--bg ' : ''
		return [...(bg ? [] : ['--bg', 'all']), 'last', ...closedSessions().map((s) => s.id)]
			.map((v) => prefix + v)
			.filter((v) => v.startsWith(args))
	},
	run(args, _answers, ctx) {
		let bg = /^--bg(?:\s|$)/.test(args)
		if (bg) {
			args = args.slice(4).trim()
			if (!args || args === 'all') return { error: 'usage: /resume --bg <session id|last>' }
		}
		if (!args || args === 'all') {
			let shut = closedSessions()
			let rows = (args ? shut : shut.slice(0, recent)).map((s) => sessionRow(s, ctx.sessionId))
			if (!args && shut.length > recent) rows.push(`${shut.length - recent} more: /resume all`)
			return { say: rows.join('\n') || 'No closed sessions.' }
		}
		let outcome
		try {
			outcome = tabs.act({ type: 'tab-resume', ...(args !== 'last' && { sessionId: args }) })
		} catch {
			return { error: `no session ${args}` }
		}
		if (outcome.refused) return { error: outcome.refused }
		if (!bg) host.broadcast(ctx.sessionId, { type: 'go', sessionId: ctx.sessionId, tab: outcome.tab! })
		return { result: `reopened ${outcome.tab}` }
	},
}
