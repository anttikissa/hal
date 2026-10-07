// /rebase editor and sparse command plans, applied between settled rounds.
// Tasks: z71, svt.
import type { SlashCommand } from '../commands.ts'
import { rebasePlans } from '../rebase-plans.ts'

export const command: SlashCommand = {
	help: () => '/rebase [--paused] opens the editor/view; undo restores the last rewrite. /rebase show lists a snapshot; /rebase preview <plan> validates without applying; /rebase run [--paused] <plan> applies (run is optional). Sparse plans keep unmentioned entries: drop #12,t20-30,40-; edit #u7 "full replacement". Bare ranges include all kinds; prefixes filter t tool, r thinking, a assistant, u user, m inbox, s system. Open tails include entries through application, including this rebase call/result. Separate operations with semicolons; quote edit text with double, single or backtick quotes; escapes: backslash, active quote, n, t. No insertion. Ordinary appends are allowed; context rewrites invalidate the shown snapshot. Applies after active work settles; trailing prompts continue automatically; --paused suppresses continuation and ends a model turn. Agents: use only with user consent. Use --paused if user asks.',
	complete: (args) => ['show', 'preview', 'run', 'undo', '--paused'].filter((s) => s.startsWith(args)),
	run: (args, _answers, ctx) => {
		if (ctx.sender?.from) return { error: 'Run /rebase in this session, not from another session.' }
		let paused = false
		args = args.trim()
		if (/^--paused(?:\s|$)/.test(args)) { paused = true; args = args.slice(8).trimStart() }
		if (args === 'undo') {
			if (paused) return { error: '/rebase undo already leaves continuation to you; use --paused with an editor or run plan.' }
			return { result: rebasePlans.undo(ctx.sessionId) }
		}
		if (!args) {
			if (ctx.sender?.origin === 'model') return { error: 'Use /rebase show, preview <plan> or run [--paused] <plan>.' }
			return { rebase: { ...rebasePlans.build(ctx.sessionId), ...(paused && { paused: true as const }) } }
		}
		let agent = (require('../rebase-agent.ts') as typeof import('../rebase-agent.ts')).rebaseAgent
		if (args === 'show') return { say: agent.show(ctx.sessionId) }
		let action = /^(preview|run)(?:\s+|$)/.exec(args)
		if (action) args = args.slice(action[0].length)
		if (/^--paused(?:\s|$)/.test(args)) { paused = true; args = args.slice(8).trimStart() }
		let text = agent.request(ctx.sessionId, args, action?.[1] === 'preview', paused, ctx.sender)
		return action?.[1] === 'preview' ? { say: text } : { result: text }
	},
}
