// /account: this session moves to another login of its model's provider.
// Rotation still leaves it once it is rate limited or broken (auth.ts).

import { auth, type Kind } from '../auth.ts'
import type { Context, SlashCommand } from '../commands.ts'

function kindOf(ctx: Context): Kind | undefined {
	let kind = ctx.model.split('/')[0]
	return kind === 'anthropic' || kind === 'openai' ? kind : undefined
}

const names = (kind: Kind) => auth.all(kind).list.map((a) => a.name)

export const command: SlashCommand = {
	help: () => '/account asks which login of the model\'s provider this session uses, the current one chosen; /account <name|number> switches to it from the next request. When it is rate limited or broken, rotation moves on as usual. /status lists the accounts.',
	complete(args, ctx) {
		let kind = kindOf(ctx)
		try { return kind ? names(kind).filter((n) => n.startsWith(args)) : [] } catch { return [] }
	},
	run(args, answers, ctx) {
		let kind = kindOf(ctx)
		if (!kind) return { error: `/account switches anthropic or openai logins; this session uses ${ctx.model}` }
		let list = names(kind)
		if (!args && !answers) {
			let key = `${kind} ${ctx.sessionId}`
			let current = auth.state.chosen.get(key) ?? auth.pickAccount(kind, auth.all(kind).list, { session: ctx.sessionId })[0]?.name
			return { ask: { text: `Pick the ${kind} account for this session.`, fields: [{ type: 'choice', name: 'account', options: list, initial: Math.max(0, list.indexOf(current ?? '')) }] } }
		}
		args ||= answers?.account ?? ''
		let name = list.includes(args) ? args : /^\d+$/.test(args) ? list[Number(args) - 1] : undefined
		if (!name) return { error: `unknown ${kind} account ${args}: choose ${list.map((n, i) => `${i + 1} ${n}`).join(', ')}` }
		let account = auth.all(kind).list.find((a) => a.name === name)!
		if (auth.skipped(kind, account, ctx.model.slice(kind.length + 1))) return { error: `${kind} account ${name} is rate limited for ${ctx.model} or its login is broken; /status shows why` }
		auth.choose(kind, ctx.sessionId, name)
		return { say: `this session uses ${kind} account ${name} from its next request` }
	},
}
