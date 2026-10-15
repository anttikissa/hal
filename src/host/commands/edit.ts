// /edit <prompt> <text> edits a prompt of yours and runs it again;
// /edit undo restores the prompt the latest edit replaced (tasks ky7, hx8).
import type { SlashCommand } from '../commands.ts'
import { rebasePlans } from '../rebase-plans.ts'

export const command: SlashCommand = {
	quiet: true,
	help: () => '/edit <prompt> <text>: replace prompt <prompt> (u12 or 12) and what followed it with <text>, newlines included, and run it. If something with side effects ran since, <text> is sent as a new prompt. Up in an empty prompt box opens your latest prompt for this; Up again goes to older ones.\n/edit undo: restore the prompt the latest edit replaced, with its partial output, and leave the session paused. A running turn is paused first. `/rebase undo` after `/edit undo` keeps both versions.',
	run: (args, _answers, ctx) => {
		if (ctx.sender?.from) return { error: 'Run /edit in this session, not from another session.' }
		if (args.trim() === 'undo') return { say: rebasePlans.unamend(ctx.sessionId) }
		let m = /^\s*[u#]?(\d+)[ \t]*\n?([\s\S]+)$/.exec(args)
		if (!m?.[2]!.trim()) return { error: 'Usage: /edit <prompt> <text>, or /edit undo.' }
		let refused = rebasePlans.rewind(ctx.sessionId, Number(m[1]), m[2]!, ctx.command)
		return refused ? { error: refused } : {}
	},
}
