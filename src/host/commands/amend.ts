// /amend <prompt> <text> edits a prompt of yours and runs it again;
// /amend undo restores the prompt the latest amend replaced (tasks ky7, hx8).
import type { SlashCommand } from '../commands.ts'
import { rebasePlans } from '../rebase-plans.ts'

export const command: SlashCommand = {
	quiet: true,
	help: () => '/amend <prompt> <text>: replace prompt <prompt> (u12 or 12) and what followed it with <text>, newlines included, and run it. If something with side effects ran since, <text> is sent as a new prompt.\n/amend undo: restore the prompt the latest amend replaced, with its partial output, and leave the session paused.',
	run: (args, _answers, ctx) => {
		if (ctx.sender?.from) return { error: 'Run /amend in this session, not from another session.' }
		if (args.trim() === 'undo') return { result: rebasePlans.unamend(ctx.sessionId) }
		let m = /^\s*[u#]?(\d+)[ \t]*\n?([\s\S]+)$/.exec(args)
		if (!m?.[2]!.trim()) return { error: 'Usage: /amend <prompt> <text>, or /amend undo.' }
		let refused = rebasePlans.rewind(ctx.sessionId, Number(m[1]), m[2]!, ctx.command)
		return refused ? { error: refused } : {}
	},
}
