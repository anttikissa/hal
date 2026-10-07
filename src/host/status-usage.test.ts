import { expect, test } from 'bun:test'
import { statusUsage } from './status-usage.ts'
import { auth } from './auth.ts'
import { clock } from './clock.ts'
import { usage } from './usage.ts'
import { liveFiles } from './live-file.ts'
import { limits } from './limits.ts'



test('stale usage refreshes only subscriptions and failed auth leaves cached windows with short advice', async () => {
	let all = auth.all, refresh = statusUsage.refresh, store = usage.store, windows = usage.windows, now = clock.now
	let when = Date.now()
	clock.now = () => when
	let data = { anthropic: { 'a@example.com': { '5h': { used: 12, observed: new Date(when - 120000).toISOString() } } } }
	let requests = 0
	auth.all = ((kind: string) => ({ data: {}, list: kind === 'anthropic' ? [{ entry: { accessToken: 'token' }, name: 'a@example.com', replace: () => {} }, { entry: { apiKey: 'key' }, name: 'ANTHROPIC_API_KEY', replace: () => {} }] : [] })) as typeof all
	usage.store = () => data
	usage.windows = (_kind, account) => data.anthropic[account as 'a@example.com'] ?? {}
	statusUsage.refresh = async () => { requests++; throw Error('/private/auth.ason: token expired and there is no refreshToken; run /login claude') }
	try {
		let result = await statusUsage.show('s', 'fake/m1')
		expect(requests).toBe(1)
		expect(result).toContain('Runtime:')
		expect(result).toContain(`PID: ${process.pid}`)
		expect(result).toContain('12% used')
		expect(result).toContain('login expired — showing cached usage')
		expect(result).toContain('To log in again, run /login claude or /login chatgpt.')
		expect(result).not.toContain('/private/auth.ason')
		data.anthropic['a@example.com']['5h'].observed = new Date(when).toISOString()
		result = await statusUsage.show('s', 'fake/m1')
		expect(requests).toBe(1)
		expect(result).not.toContain('login expired')
	} finally { auth.all = all; statusUsage.refresh = refresh; usage.store = store; usage.windows = windows; clock.now = now }
})

// A usage response can name a login previously identified only by slot.
test('refresh learns email and plan, reports a plan change, and replaces windows the endpoint no longer lists', async () => {
	let all = auth.all, credential = auth.credential, store = usage.store, save = liveFiles.save, fetchOld = globalThis.fetch
	let entry: Record<string, any> = { accessToken: 'token' }
	let account = { name: 'account 3', entry, replace: () => {} }
	let records: Record<string, Record<string, Record<string, { used: number; observed?: string }>>> = { openai: { 'account 3': { '7d': { used: 70 } } } }
	let saves = 0
	auth.all = (() => ({ data: {}, list: [account] })) as typeof all
	auth.credential = (async () => ({ type: 'token', value: 'token', account: account.name })) as typeof credential
	usage.store = () => records
	liveFiles.save = (() => { saves++ }) as typeof save
	globalThis.fetch = (async () => Response.json({ email: 'bob@example.com', plan_type: 'plus', rate_limit: { primary_window: { used_percent: 24, limit_window_seconds: 18000, reset_at: Math.floor(Date.now() / 1000) + 300 } } })) as unknown as typeof fetch
	try {
		expect(await statusUsage.refresh('openai', account as any)).toBeUndefined()
		expect(entry.email).toBe('bob@example.com')
		expect(entry.plan).toBe('plus')
		expect(records.openai?.['account 3']).toBeUndefined()
		expect(records.openai?.['bob@example.com']?.['7d']).toBeUndefined()
		expect(records.openai?.['bob@example.com']?.['5h']?.used).toBe(24)
		expect(saves).toBe(1)
		globalThis.fetch = (async () => Response.json({ plan_type: 'free', rate_limit: { primary_window: { used_percent: 1, limit_window_seconds: 30 * 86400 } } })) as unknown as typeof fetch
		expect(await statusUsage.refresh('openai', account as any)).toBe('plus → free')
		expect(Object.keys(records.openai?.['account 3'] ?? {})).toEqual(['30d'])
	} finally { auth.all = all; auth.credential = credential; usage.store = store; liveFiles.save = save; globalThis.fetch = fetchOld }
})

// Shape of a real /api/oauth/usage answer (2 Oct 2026): percent, not a fraction.
test('Anthropic usage endpoint utilization is already percent', () => {
	let w = statusUsage.payload('anthropic', { five_hour: { utilization: 9, resets_at: '2026-10-02T10:09:59.848904+00:00' }, seven_day: { utilization: 70, resets_at: '2026-10-05T20:59:59.848929+00:00' } })
	expect(w['5h']).toEqual({ used: 9, resets: '2026-10-02T10:09:59.848Z' })
	expect(w['7d']?.used).toBe(70)
})

// 2 Oct 2026: a plan refusal from before an upgrade kept a plus account
// skipped while /status showed it at 0%.
test('fresh usage with room clears the account skip and wakes waiting turns', async () => {
	let all = auth.all, credential = auth.credential, store = usage.store, lstore = limits.store, save = liveFiles.save, fetchOld = globalThis.fetch
	let account = { name: 'a@example.com', entry: { accessToken: 't', email: 'a@example.com' }, replace: () => {} }
	let skips: Record<string, string> = { 'openai/m a@example.com': new Date(Date.now() + 3600_000).toISOString(), 'openai a@example.com': new Date(Date.now() + 3600_000).toISOString(), 'openai/m b@example.com': new Date(Date.now() + 3600_000).toISOString() }
	auth.all = (() => ({ data: {}, list: [account] })) as typeof all
	auth.credential = (async () => ({ type: 'token', value: 't', account: account.name })) as typeof credential
	usage.store = () => ({})
	limits.store = () => skips
	liveFiles.save = (() => {}) as typeof save
	let logins = auth.state.logins
	try {
		globalThis.fetch = (async () => Response.json({ rate_limit: { primary_window: { used_percent: 100, limit_window_seconds: 18000 } } })) as unknown as typeof fetch
		await statusUsage.refresh('openai', account as any)
		expect(Object.keys(skips)).toHaveLength(3)
		globalThis.fetch = (async () => Response.json({ rate_limit: { primary_window: { used_percent: 0, limit_window_seconds: 18000 } } })) as unknown as typeof fetch
		await statusUsage.refresh('openai', account as any)
		expect(Object.keys(skips)).toEqual(['openai/m b@example.com'])
		expect(auth.state.logins).toBe(logins + 1)
	} finally { auth.all = all; auth.credential = credential; usage.store = store; limits.store = lstore; liveFiles.save = save; globalThis.fetch = fetchOld }
})

// Enter on a waiting turn forces it; a limited wait after a restart runs
// it once per provider, rereading only that provider's skipped accounts.
test('recheck rereads only the provider\'s skipped accounts, once unless forced', async () => {
	let all = auth.all, refresh = statusUsage.refresh, lstore = limits.store
	let names = ['a@example.com', 'b@example.com']
	auth.all = ((kind: string) => ({ data: {}, list: kind === 'openai' ? names.map((name) => ({ name, entry: {}, replace: () => {} })) : [] })) as typeof all
	limits.store = () => ({ 'openai a@example.com': '2099-01-01T00:00:00Z', 'anthropic/m b@example.com': '2099-01-01T00:00:00Z' })
	let read: string[] = []
	statusUsage.refresh = (async (kind: string, a: { name: string }) => { read.push(`${kind} ${a.name}`) }) as typeof refresh
	statusUsage.state.checked.clear()
	try {
		await Promise.all([statusUsage.recheck('openai'), statusUsage.recheck('openai')])
		await statusUsage.recheck('openai')
		expect(read).toEqual(['openai a@example.com'])
		await statusUsage.recheck('openai', true)
		expect(read).toEqual(['openai a@example.com', 'openai a@example.com'])
	} finally { auth.all = all; statusUsage.refresh = refresh; limits.store = lstore; statusUsage.state.checked.clear() }
})
