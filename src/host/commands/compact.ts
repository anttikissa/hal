// /compact: summarise older context in place (tasks bc, jf). Active
// work settles first; the same turn continues with its prompts kept.

import type { SlashCommand } from '../commands.ts'
import { contextTransitions } from '../context-transitions.ts'

export const command: SlashCommand = {
	help: () => '/compact: summarise earlier context after active work settles, between rounds; preserve active prompts and continue the same turn. The transcript and full history stay. Escape cancels a pending operation.',
	run: (_args, _answers, ctx) => contextTransitions.request(ctx.sessionId, 'compact', '', ctx.sender),
}
