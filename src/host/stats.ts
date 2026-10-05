// What a session's status row shows that clients cannot work out
// (task 1g; common/protocol.ts Stats): the context the last round took
// in, the model's context window, the tokens the session's turns sent
// and received since this host started, and the usage windows of the
// subscription account its next request goes to. Sent with snapshots,
// turn ends and model changes; nothing polls.

import { blocks } from '../common/blocks.ts'
import type { Plan, Stats } from '../common/protocol.ts'
import type { HistoryRecord } from '../common/replay.ts'
import { auth, type Kind } from './auth.ts'
import { models } from './models.ts'
import { clock } from './clock.ts'
import { contextPage } from './context-page.ts'
import { pages } from './pages.ts'
import { sessions } from './sessions.ts'
import { usage } from './usage.ts'

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

// The session's subscription account for its next request (the one
// auth would try first) and its windows; none for an API key or a
// provider without logins.
function plan(id: string, model: string): Plan | undefined {
	let kind = blocks.parseModelId(model)?.provider
	if (kind !== 'anthropic' && kind !== 'openai') return undefined
	try {
		let { list } = auth.all(kind as Kind)
		let subs = list.filter((a) => typeof a.entry.accessToken === 'string' && a.entry.accessToken)
		let next = auth.pickAccount(kind as Kind, list, { session: id })[0]
		if (!next || !subs.includes(next)) return undefined
		let key = `${kind}:${next.name}`
		let previous = stats.state.windows.get(key)
		let windows: Record<string, number>
		let resets: Record<string, string>
		if (previous && clock.now() - previous.at < 60_000) ({ windows, resets } = previous)
		else {
			windows = {}
			resets = {}
			for (let [name, w] of Object.entries(usage.windows(kind, next.name))) {
				if (/^\d+[a-z]+[-_]/.test(name)) continue
				windows[name] = Math.round(w.used)
				if (w.resets) resets[name] = w.resets
			}
			stats.state.windows.set(key, { at: clock.now(), windows, resets })
		}
		return { account: subs.indexOf(next) + 1, accounts: subs.length, windows, ...(Object.keys(resets).length && { resets }) }
	} catch {
		// No login yet, or a broken credentials file: a turn says why.
		return undefined
	}
}

// The session's stats; `records`: history at hand to find the last
// context in when this host has not seen a turn end yet.
function of(id: string, records?: HistoryRecord[]): Stats {
	let model = sessions.open(id).model
	let committed = stats.state.tokens.get(id) ?? { sent: 0, received: 0 }
	let live = stats.state.live.get(id)
	let tokens = { sent: committed.sent + (live?.sent ?? 0), received: committed.received + (live?.received ?? 0) }
	let out: Stats = { ...tokens }
	let files = Object.keys(pages.marks(id).changedPaths ?? {}).length
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

// A finished provider round, before the turn ends. The running totals are
// provisional until turn_end records the whole turn; no double counting.
function round(id: string, usage: { input?: number; cacheRead?: number; cacheWrite?: number; output?: number }): Stats {
	let t = stats.state.live.get(id) ?? { sent: 0, received: 0 }
	stats.state.live.set(id, { sent: t.sent + (usage.input ?? 0), received: t.received + (usage.output ?? 0) })
	let context = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
	if (context) stats.state.context.set(id, context)
	contextPage.notify(id)
	return stats.of(id)
}

// Counts a recorded turn end in; returns the stats to send with it.
function ended(id: string, end: HistoryRecord & { type: 'turn_end' }): Stats {
	let t = stats.state.tokens.get(id) ?? { sent: 0, received: 0 }
	stats.state.tokens.set(id, { sent: t.sent + (end.usage.input ?? 0), received: t.received + (end.usage.output ?? 0) })
	stats.state.live.delete(id)
	if (end.context) stats.state.context.set(id, end.context)
	contextPage.notify(id)
	return stats.of(id, [end])
}

// A failed round (a 429 is recorded at once, usage.observe): the cached
// windows are stale, so the status row shows the rate limit now rather
// than up to a minute later (or never, while the turn waits it out).
function failed(id: string): Stats {
	stats.state.windows.clear()
	return stats.of(id)
}

export const stats = {
	// Per session, since this host started: tokens of its turns, and the
	// context of its last turn end.
	state: { tokens: new Map<string, { sent: number; received: number }>(), context: new Map<string, number>(), live: new Map<string, { sent: number; received: number }>(), windows: new Map<string, { at: number; windows: Record<string, number>; resets: Record<string, string> }>() },
	lastContext,
	failed,
	plan,
	of,
	round,
	ended,
}
