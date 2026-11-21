// /account: this session moves to a chosen login of its model's provider,
// or to the next one. Rotation still leaves it once it is rate limited or
// broken (auth.ts).

import { auth, type Kind } from '../auth.ts'
import type { SlashCommand } from '../commands.ts'

function kindOf(model: string): Kind | undefined {
	let kind = model.split('/')[0]
	return kind === 'anthropic' || kind === 'openai' || kind === 'opencode-go' ? kind : undefined
}

function ids(kind: Kind): string[] {
	return auth.all(kind).list.map((_, i) => auth.slot(kind, i))
}

export const command: SlashCommand = {
	help: () =>
		"/account <id> moves this session to that login of its model's provider (ids as /status shows: a2, o1), from the next request. Without an id it moves to the next login.",
	complete: (args, ctx) => {
		let kind = kindOf(ctx.model)
		if (!kind) return []
		let names = auth.all(kind).list.map((a) => a.name)
		return ids(kind)
			.map((id, i) => ({ value: id, description: names[i]! }))
			.filter((o) => o.value.startsWith(args.trim()))
	},
	run(args, _answers, ctx) {
		let kind = kindOf(ctx.model)
		if (!kind) return { error: `${ctx.model} has no accounts to switch` }
		let key = `${kind} ${ctx.sessionId}`
		let list = auth.all(kind).list.map((a) => a.name)
		let id = args.trim()
		let i: number
		if (id) {
			i = ids(kind).indexOf(id)
			if (i < 0) return { error: `${id}: no such ${kind} account; accounts are ${ids(kind).join(', ')}` }
		} else {
			let now = auth.state.picked.get(key) ?? auth.state.chosen.get(key) ?? ''
			i = (list.indexOf(now) + 1) % list.length
		}
		auth.state.picked.set(key, list[i]!)
		return { say: `this session uses ${kind} account ${auth.slot(kind, i)} ${list[i]} from its next request` }
	},
}
