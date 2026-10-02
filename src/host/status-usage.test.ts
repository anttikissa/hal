import { expect, test } from 'bun:test'
import { statusUsage } from './status-usage.ts'
import { auth } from './auth.ts'
import { clock } from './clock.ts'
import { usage } from './usage.ts'
import { liveFiles } from './live-file.ts'



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
