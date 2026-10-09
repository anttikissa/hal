// /system: inspect exactly the assembled prompt the next provider call uses.
import type { SlashCommand } from '../commands.ts'
import { clock } from '../clock.ts'
import { paths } from '../paths.ts'
import { sessions } from '../sessions.ts'
import { systemPrompt } from '../system-prompt.ts'

export const command: SlashCommand = {
	help: () => '/system: show each system prompt source with its byte size, total size, and the full assembled prompt for this session.',
	run(args, _answers, ctx) {
		if (args) return { error: 'usage: /system' }
		let { sources, text } = systemPrompt.inspect({ cwd: ctx.cwd, model: ctx.model, now: clock.now(), sessionId: ctx.sessionId, noUser: sessions.open(ctx.sessionId).noUser })
		let lines = sources.map(({ path, bytes }) => `${bytes} bytes  ${paths.display(path)}`)
		let total = sources.reduce((sum, source) => sum + source.bytes, 0)
		return { say: [...lines, `${total} bytes total`, '', text].join('\n') }
	},
}
