// /toggle opens or closes blocks on the clients following this session
// (task ghs). Fold state is theirs; the host checks the target and
// tells them. The terminal runs a typed /toggle and Ctrl-O itself,
// unrecorded; this command serves the model and other clients.
import { toggle } from '../../common/toggle.ts'
import type { SlashCommand } from '../commands.ts'
import { host } from '../host.ts'
import { pages } from '../pages.ts'

export const command: SlashCommand = {
	help: () => '/toggle [#t24 | 24 | 10-24] opens or closes blocks: one block, a range (tools, thinking and messages in it), or with no target the latest tool block.',
	run(args, _answers, ctx) {
		let target = toggle.parse(args)
		if (typeof target === 'string') return { error: target }
		let next = pages.marks(ctx.sessionId).next ?? 1
		if ('from' in target && target.from >= next) return { error: target.range ? `nothing to toggle in ${target.from}-${target.to}` : `no block ${target.from} to toggle` }
		host.broadcast(ctx.sessionId, { type: 'toggle', sessionId: ctx.sessionId, target: args.trim() })
		return { result: `Toggled ${args.trim() || 'the latest tool block'}.` }
	},
}
