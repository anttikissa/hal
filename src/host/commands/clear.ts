// /clear: a fresh context in the same tab (tasks vh, jf). Active work
// settles first; an optional literal prompt starts an attributed turn.
// The draft, name, cwd, model and tab stay.

import type { SlashCommand } from '../commands.ts'
import { contextTransitions } from '../context-transitions.ts'

export const command: SlashCommand = {
	help: () => '/clear [raw prompt]: end active work safely, clear context and the screen (history stays), then optionally start a fresh attributed turn. The prompt is literal, including newlines; Escape cancels automatic continuation.',
	run: (args, _answers, ctx) => contextTransitions.request(ctx.sessionId, 'clear', args, ctx.sender),
}
