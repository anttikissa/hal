import { expect, test } from 'bun:test'
import { client, created, useHost } from '../host-fixture.test.ts'
import { tools } from '../tools.ts'
import { tabs } from '../tabs.ts'
import { auth } from '../auth.ts'
import { clock } from '../clock.ts'
import { limits } from '../limits.ts'
import { liveFiles } from '../live-file.ts'
import { statusUsage } from '../status-usage.ts'
import { usage } from '../usage.ts'
import { nativeTool } from '../native-tool.ts'

useHost()

const inspect = (sessionId: string, input: Record<string, unknown> = {}, model?: string) => tools.run(
	{ type: 'tool_call', id: 'i', name: 'inspect', input },
	{ cwd: '/tmp', signal: new AbortController().signal, sessionId, model },
)

test('a bare call describes only the caller; scope widens it in tab order', async () => {
	let a = client()
	let first = created(a, '/tmp/first')
	let second = created(client(), '/tmp/second')
	let third = created(client(), '/tmp/first')
	// A created session is not automatically a tab; the tab bar is the source of truth.
	tabs.file().open.push(second, first, third)

	let self = (await inspect(first)).output
	expect(self).toContain(`id: ${first} (you)`)
	expect(self).toContain('context: none')
	expect(self).not.toContain(second)

	let project = (await inspect(first, { scope: 'project', fields: 'id,cwd' })).output
	expect(project.split('\n')).toEqual(['id\tcwd', `${first} (you)\t/tmp/first`, `${third}\t/tmp/first`])

	let all = (await inspect(first, { scope: 'all', fields: 'tab,id,color' })).output
	expect(all.indexOf(second)).toBeLessThan(all.indexOf(first))
	expect(all).toMatch(/\t[a-z]+$/m)
})

test('host facts without addresses; unknown values list the valid ones', async () => {
	created(client(), '/tmp/x')
	let out = (await inspect('none', { what: 'host' })).output
	expect(out).toMatch(/^pid: \d+$/m)
	expect(out).toMatch(/^clients: 1$/m)
	expect(out).not.toContain('token')
	let bad = await inspect('none', { fields: 'name,bogus' })
	expect(bad.isError).toBe(true)
	expect(bad.output).toContain('context')
	expect((await inspect('none', { scope: 'everyone' })).output).toContain('self, project, all')
})

test('clients report the terminal size they last sent', async () => {
	let c = client()
	let id = created(c, '/tmp/x')
	c.conn.send({ type: 'screen', cols: 120, rows: 56, term: 'xterm-ghostty, truecolor' })
	c.conn.send({ type: 'screen', cols: 100, rows: 40 })
	let out = (await inspect(id, { what: 'clients', fields: 'size,term,follows' })).output
	expect(out.split('\n')).toEqual(['size: 100x40', 'term: unknown', 'follows: yes'])
})

test('subscriptions refresh plans and windows, mark the caller and report quota and model limits without querying keys', async () => {
	created(client(), '/tmp/x')
	let all = auth.all, credential = auth.credential, save = liveFiles.save, fetchOld = globalThis.fetch
	let a = { name: 'a@example.test', entry: { accessToken: 'anthropic-secret', email: 'a@example.test', plan: 'max' }, replace: () => {} }
	let b = { name: 'b@example.test', entry: { accessToken: 'openai-secret', email: 'b@example.test', plan: 'plus' }, replace: () => {} }
	let key = { name: 'OPENAI_API_KEY', entry: { apiKey: 'key-secret' }, replace: () => {} }
	let requests: string[] = []
	auth.all = ((kind: string) => ({ data: {}, list: kind === 'anthropic' ? [a] : [b, key] })) as typeof all
	auth.credential = (async (_data, account) => ({ type: 'token', value: account.entry.accessToken, account: account.name })) as typeof credential
	liveFiles.save = (() => {}) as typeof save
	globalThis.fetch = (async (url: string | URL | Request) => {
		requests.push(String(url))
		return String(url).includes('anthropic') ? Response.json({ five_hour: { utilization: 18, resets_at: '2099-01-01T00:00:00Z' }, seven_day: { utilization: 57 }, seven_day_sonnet: { utilization: 72 } }) : Response.json({ plan_type: 'free', rate_limit: { primary_window: { used_percent: 100, limit_window_seconds: 18000 }, secondary_window: { used_percent: 30, limit_window_seconds: 604800 } } })
	}) as typeof fetch
	auth.state.chosen.set('openai s', b.name)
	limits.set('openai/m b@example.test', clock.now() + 3600000)
	try {
		let call = nativeTool.resolve('INSPECT subscriptions')
		expect(call.input).toEqual({ what: 'subscriptions' })
		let result = await inspect('s', call.input, 'openai/m')
		expect(result.isError).toBeUndefined()
		expect(result.output).toContain('plan: max')
		expect(result.output).toContain('plan: free')
		expect(result.output).toContain('slot: 1/2 *')
		expect(result.output).toContain('5h: 18% used; resets 2099-01-01T00:00:00.000Z; observed ')
		expect(result.output).toContain('7d_sonnet: 72% used')
		expect(result.output).toContain('status: quota exhausted')
		expect(result.output).toContain('openai/m: until ')
		expect(result.output).toContain('API key (not queried)')
		expect(result.output).not.toContain('-secret')
		expect(requests).toHaveLength(2)
		expect(usage.windows('openai', b.name)['7d']?.used).toBe(30)
	} finally { usage.close(); limits.close(); auth.all = all; auth.credential = credential; liveFiles.save = save; globalThis.fetch = fetchOld; auth.state.chosen.delete('openai s') }
})

test('subscription failures retain cached observations and full safe errors even with narrow fields', async () => {
	created(client(), '/tmp/x')
	let all = auth.all, refresh = statusUsage.refresh
	let accounts = ['expired', 'timeout', 'healthy'].map((name) => ({ name: `${name}@example.test`, entry: { accessToken: `${name}-secret` }, replace: () => {} }))
	auth.all = ((kind: string) => ({ data: {}, list: kind === 'openai' ? accounts : [] })) as typeof all
	usage.observe('openai', accounts[1]!.name, new Headers({ 'x-codex-primary-used-percent': '12', 'x-codex-primary-window-minutes': '300' }))
	statusUsage.refresh = async (_kind, account) => {
		if (account.name.startsWith('expired')) throw Error('/private/auth.ason: HTTP 401 invalid_grant expired-secret')
		if (account.name.startsWith('timeout')) throw Error('usage fetch timed out')
		usage.observe('openai', account.name, new Headers({ 'x-codex-primary-used-percent': '20', 'x-codex-primary-window-minutes': '300' }))
	}
	try {
		let result = await inspect('s', { what: 'subscriptions' })
		expect(result.isError).toBe(true)
		expect(result.output).toContain('HTTP 401; usage unavailable; run /login chatgpt')
		expect(result.output).toContain('/private/auth.ason: HTTP 401 invalid_grant <redacted>')
		expect(result.output).toContain('timed out; showing cached usage')
		expect(result.output).toMatch(/5h: 12% used; resets unknown; observed [^\n]+ \(cached\)/)
		expect(result.output).toContain('account: healthy@example.test')
		expect(result.output).toContain('status: ok')
		expect(result.output).toContain('7d: unknown')
		expect(result.output).toContain('plan: unknown')
		let narrow = await inspect('s', { what: 'subscriptions', fields: 'account,plan' })
		expect(narrow.isError).toBe(true)
		expect(narrow.output).toContain('error: /private/auth.ason: HTTP 401 invalid_grant <redacted>')
		expect(narrow.output).toContain('error: usage fetch timed out')
	} finally { usage.close(); limits.close(); auth.all = all; statusUsage.refresh = refresh }
})

test('subscription fields validate before reading accounts and absent accounts are explicit', async () => {
	let all = auth.all
	let reads = 0
	auth.all = ((kind: string) => { reads++; throw Error(`no ${kind} login`) }) as typeof all
	try {
		let bad = await inspect('s', { what: 'subscriptions', fields: 'credentials' })
		expect(bad.isError).toBe(true)
		expect(bad.output).toContain('provider, slot, account, plan, status, windows, limits, error')
		expect(reads).toBe(0)
		expect((await inspect('s', { what: 'subscriptions' })).output).toBe('No accounts configured.')
	} finally { auth.all = all }
})
