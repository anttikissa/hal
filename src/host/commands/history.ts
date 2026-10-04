import type { SlashCommand } from '../commands.ts'
import { history } from '../history.ts'

export const command: SlashCommand = {
	help: () => '/history prints this session’s history file path.',
	run: (args, _answers, ctx) => args ? { error: 'usage: /history' } : { say: history.file(ctx.sessionId) },
}
