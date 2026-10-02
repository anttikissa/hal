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

// `accounts` least used first (leastUsed): by tightest window, and on a
// tie the one whose tightest window resets sooner; otherwise in order.
function order<T>(provider: string, accounts: T[], name: (a: T) => string): T[] {
	let t = new Map(accounts.map((a) => [a, usage.tightest(provider, name(a))]))
	return [...accounts].sort((a, b) => {
		let x = t.get(a)!
		let y = t.get(b)!
		return x.used - y.used || (x.resets === y.resets ? 0 : x.resets < y.resets ? -1 : 1)
	})
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
	order,
	close,
	state: { store: null as Record<string, Record<string, Windows>> | null, path: '' },
}
