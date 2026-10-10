// What a session's status row shows that clients cannot work out
// (task 1g; common/protocol.ts Stats): the context the last round took
// in, the model's context window and the usage windows of the
// subscription account its next request goes to. Sent with snapshots,
// turn ends and model changes; nothing polls.

import { blocks } from '../common/blocks.ts'
import type { Plan, Stats } from '../common/protocol.ts'
import type { HistoryRecord } from '../common/replay.ts'
import { auth, type Kind } from './auth.ts'
import { models } from './models.ts'
import { subscriptions } from '../common/subscriptions.ts'
import { contextPage } from './context-page.ts'
import { pages } from './pages.ts'
import { sessions } from './sessions.ts'

// The context of the last turn end among `records` that has one, unless
// a compact or reset came after it: that context is gone.
function lastContext(records: HistoryRecord[]): number | undefined {
	for (let i = records.length - 1; i >= 0; i--) {
		let r = records[i]!
		if (r.type === 'compact' || r.type === 'reset') return undefined
		if (r.type === 'turn_end' && r.context) return r.context
	}
	return undefined
}

// The session's subscription account for its next request (the first
// auth.pick would use, past broken and rate-limited ones) and its
// windows; none for an API key or a provider without logins.
function plan(id: string, model: string): Plan | undefined {
	let parsed = blocks.parseModelId(model)
	let kind = parsed?.provider
	if (kind !== 'anthropic' && kind !== 'openai') return undefined
	try {
		let { list } = auth.all(kind as Kind)
		let subs = list.filter((a) => typeof a.entry.accessToken === 'string' && a.entry.accessToken)
		let next = auth.pickAccount(kind as Kind, list, { session: id }).find((a) => !auth.skipped(kind as Kind, a, parsed!.model))
		if (!next || !subs.includes(next)) return undefined
		return { account: subs.indexOf(next) + 1, accounts: subs.length, key: subscriptions.key(kind, next.name) }
	} catch {
		// No login yet, or a broken credentials file: a turn says why.
		return undefined
	}
}

// The session's stats; `records`: history at hand to find the last
// context in when this host has not seen a turn end yet.
function of(id: string, records?: HistoryRecord[]): Stats {
	let model = sessions.open(id).model
	let out: Stats = {}
	let files = pages.marks(id).files
	if (files) out.files = files
	// Only an effort off the model's default is said (task r7r).
	let level = models.effort(model, sessions.open(id).effort)
	if (level && level !== models.effort(model)) out.effort = level
	let context = stats.state.context.get(id) ?? stats.lastContext(records ?? pages.essentials(id))
	if (context) out.context = context
	let window = models.contextWindow(model)
	if (window) out.window = window
	let p = stats.plan(id, model)
	if (p) out.plan = p
	return out
}

// A finished provider round, before the turn ends: its intake is the
// context now.
function round(id: string, usage: { input?: number; cacheRead?: number; cacheWrite?: number; output?: number }): Stats {
	let context = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
	if (context) stats.state.context.set(id, context)
	contextPage.notify(id)
	return stats.of(id)
}

// A recorded turn end; returns the stats to send with it.
function ended(id: string, end: HistoryRecord & { type: 'turn_end' }): Stats {
	if (end.context) stats.state.context.set(id, end.context)
	contextPage.notify(id)
	return stats.of(id, [end])
}

export const stats = {
	// Per session, since this host started: the context of its last
	// round. Quota lives only in usage.ts.
	state: { context: new Map<string, number>() },
	lastContext,
	plan,
	of,
	round,
	ended,
}
