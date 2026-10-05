// How much of each subscription account's usage windows is spent, as
// the providers report on every response: Anthropic's unified limits
// (anthropic-ratelimit-unified-5h-utilization, a fraction, and -reset,
// unix seconds; likewise 7d and model-specific weeks) and OpenAI
// Codex's primary and secondary windows (x-codex-primary-used-percent,
// -window-minutes, -reset-at or -reset-after-seconds). Kept per
// provider and account in state/usage.ason, so account rotation
// (auth.ts) takes the least-used account, and a later /model or status
// line can show the numbers.

import { clock } from './clock.ts'
import { liveFiles } from './live-file.ts'
import { paths } from './paths.ts'

// `used`: percent 0..100; `resets`: ISO time, when known.
export type Window = { used: number; resets?: string; observed?: string }
// Window name ("5h", "7d", "7d_sonnet") -> window.
export type Windows = Record<string, Window>

// "300" minutes -> "5h", "10080" -> "7d".
function span(minutes: number): string {
	if (minutes % 1440 === 0) return `${minutes / 1440}d`
	if (minutes % 60 === 0) return `${minutes / 60}h`
	return `${minutes}m`
}

function iso(ms: number): string | undefined {
	return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : undefined
}

function num(headers: Headers, name: string): number {
	let v = headers.get(name)
	return v === null || v.trim() === '' ? NaN : Number(v)
}

// The windows a response's headers report; empty if none.
function parse(headers: Headers): Windows {
	let out: Windows = {}
	let put = (name: string, used: number, resets: number) => {
		if (!Number.isFinite(used)) return
		let w: Window = { used: Math.max(0, Math.min(100, used)) }
		let at = iso(resets)
		if (at) w.resets = at
		out[name] = w
	}
	for (let [key] of headers) {
		// Only windows named by their span: 5h, 7d, 7d_opus, ...
		let m = /^anthropic-ratelimit-unified-(\d+[a-z][\w-]*?)-utilization$/.exec(key)
		if (m) put(m[1]!, num(headers, key) * 100, num(headers, `anthropic-ratelimit-unified-${m[1]}-reset`) * 1000)
	}
	for (let which of ['primary', 'secondary']) {
		let p = `x-codex-${which}-`
		let used = num(headers, `${p}used-percent`)
		if (!Number.isFinite(used)) continue
		let minutes = num(headers, `${p}window-minutes`)
		let at = num(headers, `${p}reset-at`) * 1000
		if (!Number.isFinite(at)) at = clock.now() + num(headers, `${p}reset-after-seconds`) * 1000
		put(minutes > 0 ? span(minutes) : which, used, at)
	}
	return out
}

// The live file for the current home; reopened if the home changes.
// provider -> account -> windows.
function store(): Record<string, Record<string, Windows>> {
	let path = `${paths.stateDir()}/usage.ason`
	if (usage.state.store && usage.state.path === path) return usage.state.store
	usage.close()
	usage.state.store = liveFiles.liveFile(path, {}, { watch: false, mode: 0o600 })
	usage.state.path = path
	return usage.state.store
}

// Records what a response of `provider` for `account` reported.
function observe(provider: string, account: string | undefined, headers: Headers): void {
	let windows = usage.parse(headers)
	if (!account || !Object.keys(windows).length) return
	let data = usage.store()
	data[provider] ??= {}
	let observed = new Date(clock.now()).toISOString()
	data[provider]![account] = { ...data[provider]![account], ...Object.fromEntries(Object.entries(windows).map(([name, w]) => [name, { ...w, observed }])) }
}

// The account's windows still running (a window past its reset counts
// as unused, so it is left out).
function windows(provider: string, account: string): Windows {
	let out: Windows = {}
	for (let [name, w] of Object.entries(usage.store()[provider]?.[account] ?? {})) {
		if (w.resets && !(Date.parse(w.resets) > clock.now())) continue
		out[name] = w
	}
	return out
}

// The account's tightest window: most used, and of equals the one
// resetting soonest. An account without data is unused.
function tightest(provider: string, account: string): { used: number; resets: number } {
	let best = { used: 0, resets: Infinity }
	for (let [name, w] of Object.entries(usage.windows(provider, account))) {
		// Model-specific windows do not constrain another model's quota.
		if (/^\d+[a-z]+[-_]/.test(name)) continue
		let resets = w.resets ? Date.parse(w.resets) : Infinity
		if (w.used > best.used || (w.used === best.used && resets < best.resets)) best = { used: w.used, resets }
	}
	return best
}

// Where an account stands for rotation (task 3vj). Eligible: every
// shared window below nearly spent (5h under 95%, others under 98%).
// `week`: when its 7d window resets, Infinity when unknown.
function standing(provider: string, account: string): { eligible: boolean; week: number; used: number } {
	let all = usage.windows(provider, account)
	let eligible = Object.entries(all).every(([name, w]) => /^\d+[a-z]+[-_]/.test(name) || w.used < (name === '5h' ? 95 : 98))
	let week = all['7d']?.resets ? Date.parse(all['7d'].resets) : Infinity
	return { eligible, week, used: usage.tightest(provider, account).used }
}

// `accounts` in rotation order: eligible ones whose week resets soonest
// first, so quota is spent before it expires, then the least used; the
// nearly spent ones last, least used first. Full ties keep their order.
function order<T>(provider: string, accounts: T[], name: (a: T) => string): T[] {
	let t = new Map(accounts.map((a) => [a, usage.standing(provider, name(a))]))
	return [...accounts].sort((a, b) => {
		let x = t.get(a)!
		let y = t.get(b)!
		if (x.eligible !== y.eligible) return x.eligible ? -1 : 1
		if (x.eligible && x.week !== y.week) return x.week < y.week ? -1 : 1
		return x.used - y.used
	})
}

// Whether a session on `mine` stays there rather than moving to `best`,
// the first in order(): while it is eligible, unless best's week resets
// within a day and sooner than mine's (its quota would otherwise expire).
function keeps(provider: string, mine: string, best: string): boolean {
	let m = usage.standing(provider, mine)
	let b = usage.standing(provider, best)
	return m.eligible && !(b.eligible && b.week < m.week && b.week <= clock.now() + 86400_000)
}

function close(): void {
	let s = usage.state.store
	usage.state.store = null
	usage.state.path = ''
	if (s) liveFiles.close(s)
}

export const usage = {
	parse,
	span,
	store,
	observe,
	windows,
	tightest,
	standing,
	order,
	keeps,
	close,
	state: { store: null as Record<string, Record<string, Windows>> | null, path: '' },
}
