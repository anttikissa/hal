// /account: this session moves to the next login of its model's provider.
// Rotation still leaves it once it is rate limited or broken (auth.ts).

import { auth } from '../auth.ts'
import type { SlashCommand } from '../commands.ts'

export const command: SlashCommand = {
	help: () => '/account moves this session to the next login of its model\'s provider, from the next request. /status lists them.',
	run(_args, _answers, ctx) {
		let kind = ctx.model.split('/')[0]
		if (kind !== 'anthropic' && kind !== 'openai') return { error: `${ctx.model} has no accounts to switch` }
		let key = `${kind} ${ctx.sessionId}`
		let list = auth.all(kind).list.map((a) => a.name)
		let now = auth.state.picked.get(key) ?? auth.state.chosen.get(key) ?? ''
		let next = list[(list.indexOf(now) + 1) % list.length]!
		auth.state.picked.set(key, next)
		return { say: `this session uses ${kind} account ${next} from its next request` }
	},
}
