// /compact: summarize older context in place (tasks bc, jf). Active
// work settles first; the same turn continues with its prompts kept.

import type { SlashCommand } from '../commands.ts'
import { contextTransitions } from '../context-transitions.ts'

export const command: SlashCommand = {
	help: () => '/compact: summarize earlier context after active work settles, between rounds; preserve active prompts and continue the same turn. The transcript and full history stay. Escape cancels a pending operation.\n/compact undo: restore the context the latest compaction summarized, keeping later work; /rebase undo reverses it.',
	run: (args, _answers, ctx) => args.trim() === 'undo' ? contextTransitions.undo(ctx.sessionId, 'compact', ctx.sender) : contextTransitions.request(ctx.sessionId, 'compact', '', ctx.sender),
}
