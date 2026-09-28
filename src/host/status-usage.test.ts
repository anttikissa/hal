import { expect, test } from 'bun:test'
import { statusUsage } from './status-usage.ts'
import { auth } from './auth.ts'
import { clock } from './clock.ts'
import { usage } from './usage.ts'

test('status masks account identities, marks selected account and formats reset days', () => {
	let now = new Date(2026, 8, 28, 12).getTime()
	let old = clock.now
	clock.now = () => now
	try {
		let text = statusUsage.table([
			{ provider: 'anthropic', slot: '2/3 *', account: statusUsage.mask('alice@gmail.com'), apiKey: false, windows: { '5h': { used: 42, resets: new Date(now + 3600_000).toISOString() }, '7d': { used: 90, resets: new Date(now + 5 * 86400_000).toISOString() } } },
			{ provider: 'openai', slot: '1/1', account: 'OPENAI_API_KEY', apiKey: true, windows: {} },
		])
		expect(text).toContain('a***@g****.com')
		expect(text).not.toContain('alice@gmail.com')
		expect(text).toContain('2/3 *')
		expect(text).toContain('42% used (resets today at')
		expect(text).toContain('90% used (resets on 3 Oct at')
		expect(text).toContain('API key')
	} finally { clock.now = old }
})

test('stale usage is refreshed; a failed refresh keeps cached windows', async () => {
	let all = auth.all, refresh = statusUsage.refresh, store = usage.store, windows = usage.windows, now = clock.now
	let when = Date.now()
	clock.now = () => when
	let data = { anthropic: { 'a@example.com': { '5h': { used: 12, observed: new Date(when - 120000).toISOString() } } } }
	let requests = 0
	auth.all = ((kind: string) => ({ data: {}, list: kind === 'anthropic' ? [{ entry: { accessToken: 'token' }, name: 'a@example.com', replace: () => {} }] : [] })) as typeof all
	usage.store = () => data
	usage.windows = (_kind, account) => data.anthropic[account as 'a@example.com'] ?? {}
	statusUsage.refresh = async () => { requests++; throw Error('offline') }
	try {
		let result = await statusUsage.show('s', 'fake/m1')
		expect(requests).toBe(1)
		expect(result).toContain('12% used')
		expect(result).toContain('showing cached usage')
		data.anthropic['a@example.com']['5h'].observed = new Date(when).toISOString()
		await statusUsage.show('s', 'fake/m1')
		expect(requests).toBe(1)
	} finally { auth.all = all; statusUsage.refresh = refresh; usage.store = store; usage.windows = windows; clock.now = now }
})
