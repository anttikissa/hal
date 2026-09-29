import { expect, test } from 'bun:test'
import { statusUsage } from './status-usage.ts'
import { auth } from './auth.ts'
import { clock } from './clock.ts'
import { usage } from './usage.ts'
import { liveFiles } from './live-file.ts'
import { markdown } from '../common/markdown.ts'
import { markdownView } from '../client/markdown-view.ts'

const visible = (s: string) => s.replace(/\x1b\]8;;[^\x07]*\x07/g, '').replace(/\x1b\[[\d;]*m/g, '')

test('provider-specific tables show full identities, plan and two-line reset cells', () => {
	let now = new Date(2026, 8, 28, 12).getTime()
	let old = clock.now
	clock.now = () => now
	try {
		let text = statusUsage.table([
			{ provider: 'anthropic', slot: '2/3 *', account: 'alice@gmail.com', apiKey: false, windows: { '5h': { used: 42, resets: new Date(now + 3600_000).toISOString() }, '7d_sonnet': { used: 90, resets: new Date(now + 5 * 86400_000).toISOString() } } },
			{ provider: 'openai', slot: '1/2', account: 'bob@longdomain.org', plan: 'plus', apiKey: false, windows: { '5h': { used: 0 } } },
			{ provider: 'openai', slot: '2/2', account: 'OPENAI_API_KEY', apiKey: true, windows: {} },
		])
		let tables = markdown.parse(text).filter((b) => b.type === 'table')
		expect(tables).toHaveLength(2)
		expect(tables[0]!.type === 'table' && tables[0]!.rows[0]!.map((c) => c.map((r) => r.text).join(''))).toEqual(['Slot', 'Account', '5h'])
		expect(tables[1]!.type === 'table' && tables[1]!.rows[0]!.map((c) => c.map((r) => r.text).join(''))).toEqual(['Slot', 'Account', '5h'])
		let rendered = markdownView.lines(text, 100).map(visible).join('\n')
		expect(rendered).toContain('alice@gmail.com')
		expect(rendered).toContain('bob@longdomain.org (plus)')
		expect(rendered).toContain('2/3 *')
		expect(rendered).toContain('42% used (resets 13:00)')
		expect(rendered).not.toContain('sonnet')
		expect(rendered).toContain('API key')
		expect(rendered).not.toContain('<br>')
		expect(rendered).not.toContain('| Slot |')
	} finally { clock.now = old }
})

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
test('refresh learns email and plan and moves cached windows to the named account', async () => {
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
		await statusUsage.refresh('openai', account as any)
		expect(entry.email).toBe('bob@example.com')
		expect(entry.plan).toBe('plus')
		expect(records.openai?.['account 3']).toBeUndefined()
		expect(records.openai?.['bob@example.com']?.['7d']?.used).toBe(70)
		expect(records.openai?.['bob@example.com']?.['5h']?.used).toBe(24)
		expect(saves).toBe(1)
	} finally { auth.all = all; auth.credential = credential; usage.store = store; liveFiles.save = save; globalThis.fetch = fetchOld }
})
