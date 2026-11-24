// /account: this session moves to a chosen login of its model's provider,
// or to the next one. Rotation still leaves it once it is rate limited or
// broken (auth.ts, agy-accounts.ts).

import { agyAccounts } from '../agy-accounts.ts'
import { auth, type Kind } from '../auth.ts'
import type { SlashCommand } from '../commands.ts'
import { host } from '../host.ts'
import { sessions } from '../sessions.ts'
import { stats } from '../stats.ts'

function kindOf(model: string): Kind | 'agy' | undefined {
	let kind = model.split('/')[0]
	return kind === 'anthropic' || kind === 'openai' || kind === 'opencode-go' || kind === 'agy' ? kind : undefined
}

// Ids and names of the kind's accounts, using the slot ids /status shows.
function accounts(kind: Kind | 'agy'): { id: string; name: string }[] {
	if (kind === 'agy') return agyAccounts.list().map((a, i) => ({ id: auth.slot('agy', i), name: a.name }))
	return auth.all(kind).list.map((a, i) => ({ id: auth.slot(kind, i), name: a.name }))
}

// The session's current and /account-picked account of the kind.
function choices(kind: Kind | 'agy', sessionId: string): { picked: Map<string, string>; key: string; now: string } {
	let [picked, chosen, key] =
		kind === 'agy'
			? [agyAccounts.state.picked, agyAccounts.state.chosen, sessionId]
			: [auth.state.picked, auth.state.chosen, `${kind} ${sessionId}`]
	return { picked, key, now: picked.get(key) ?? chosen.get(key) ?? '' }
}

export const command: SlashCommand = {
	help: () =>
		"/account <id> moves this session to that login of its model's provider (ids as /status shows: a2, o1, g1, y1), from the next request. Without an id it moves to the next login.",
	complete: (args, ctx) => {
		let kind = kindOf(ctx.model)
		if (!kind) return []
		return accounts(kind)
			.map((a) => ({ value: a.id, description: a.name }))
			.filter((o) => o.value.startsWith(args.trim()))
	},
	run(args, _answers, ctx) {
		let kind = kindOf(ctx.model)
		if (!kind) return { error: `${ctx.model} has no accounts to switch` }
		let list = accounts(kind)
		if (!list.length) return { error: `no ${kind} accounts configured; run /login ${kind}` }
		let { picked, key, now } = choices(kind, ctx.sessionId)
		let id = args.trim()
		let i: number
		if (id) {
			i = list.findIndex((a) => a.id === id)
			if (i < 0) return { error: `${id}: no such ${kind} account; accounts are ${list.map((a) => a.id).join(', ')}` }
		} else i = (list.findIndex((a) => a.name === now) + 1) % list.length
		picked.set(key, list[i]!.name)
		if (sessions.state.open.has(ctx.sessionId))
			host.broadcast(ctx.sessionId, { type: 'turn-stats', sessionId: ctx.sessionId, stats: stats.of(ctx.sessionId) })
		let label = list[i]!.id === list[i]!.name ? list[i]!.name : `${list[i]!.id} ${list[i]!.name}`
		return { say: `this session uses ${kind} account ${label} from its next request` }
	},
}
