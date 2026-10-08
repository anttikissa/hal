// The status row's numbers the host sends (stats.ts, task 1g).

import { expect, test } from 'bun:test'
import { writeFileSync } from 'fs'
import { ason } from '../common/ason.ts'
import { calls, client, created, fresh, restartHost, until, useHost } from './host-fixture.test.ts'
import { subscriptions } from '../common/subscriptions.ts'
import { auth } from './auth.ts'
import { models } from './models.ts'
import { paths } from './paths.ts'
import { stats } from './stats.ts'
import { usage } from './usage.ts'
import { statusUsage } from './status-usage.ts'

useHost()

async function turn(c: ReturnType<typeof client>, id: string, ...rounds: { input: number; cacheRead?: number; output: number }[]) {
	let before = c.of('turn-end').length
	c.conn.send({ type: 'submit', sessionId: id, text: 'go' })
	for (let [i, u] of rounds.entries()) {
		await until(() => calls.length > i + before)
		let last = i === rounds.length - 1
		let call = calls[calls.length - 1]!
		if (!last) call.push({ type: 'tool_call', id: `t${i}`, name: 'nope', input: {} })
		call.push({ type: 'usage', usage: u }, { type: 'done', reason: last ? 'end' : 'tool_use' })
	}
	await until(() => c.of('turn-end').length > before)
	return c.of('turn-end').at(-1).stats
}

test('turn ends carry the last round’s context, which a new host keeps', async () => {
	let c = client()
	let id = created(c)
	expect(c.of('snapshot').at(-1).snapshot.stats).toEqual({})
	// Two rounds: the context is the last round's intake, cache included.
	expect(await turn(c, id, { input: 900, output: 10 }, { input: 50, cacheRead: 1000, output: 20 })).toEqual({ context: 1050 })
	expect(await turn(c, id, { input: 7, cacheRead: 2000, output: 5 })).toEqual({ context: 2007 })
	expect((await fresh(id)).stats).toEqual({ context: 2007 })
	restartHost()
	expect((await fresh(id)).stats).toEqual({ context: 2007 })
})

test('the context follows each provider round while tools run', async () => {
	let c = client(), id = created(c)
	c.conn.send({ type: 'submit', sessionId: id, text: 'go' })
	await until(() => calls.length === 1)
	calls[0]!.push({ type: 'tool_call', id: 't1', name: 'nope', input: {} }, { type: 'usage', usage: { input: 900, output: 5 } }, { type: 'done', reason: 'tool_use' })
	await until(() => calls.length === 2)
	expect(c.of('turn-end')).toHaveLength(0)
	expect(c.views.get(id)!.stats).toMatchObject({ context: 900 })
	calls[1]!.push({ type: 'usage', usage: { input: 50, cacheRead: 1000, output: 20 } }, { type: 'done', reason: 'end' })
	await until(() => c.of('turn-end').length)
	expect(c.of('turn-stats').map((event) => event.stats.context)).toEqual([900, 1050])
	expect(c.views.get(id)!.stats).toMatchObject({ context: 1050 })
	expect((await fresh(id)).stats).toEqual(c.views.get(id)!.stats)
})

test('a model change sends the new model’s context window', async () => {
	let orig = models.contextWindow
	models.contextWindow = (m) => (m === 'hal/intro' ? 1_000_000 : undefined)
	try {
		let c = client()
		let id = created(c)
		c.conn.send({ type: 'submit', sessionId: id, text: '/model hal/intro' })
		await until(() => c.of('meta').length)
		expect(c.of('meta').at(-1).stats.window).toBe(1_000_000)
		expect(c.views.get(id)!.stats!.window).toBe(1_000_000)
	} finally {
		models.contextWindow = orig
	}
})

test('the plan is the subscription account the next request takes, with its windows', () => {
	let saved = process.env.ANTHROPIC_API_KEY
	delete process.env.ANTHROPIC_API_KEY
	try {
		let c = client()
		let id = created(c)
		expect(stats.plan(id, 'anthropic/claude-opus-5-5')).toBeUndefined()
		paths.init()
		writeFileSync(paths.authFile(), ason.stringify({ anthropic: [{ accessToken: 'a', email: 'one' }, { accessToken: 'b', email: 'two' }, { apiKey: 'k' }] }), { mode: 0o600 })
		let h = (u5: string, u7: string) => new Headers({ 'anthropic-ratelimit-unified-5h-utilization': u5, 'anthropic-ratelimit-unified-7d-utilization': u7 })
		usage.observe('anthropic', 'one', h('0.9', '0.5'))
		usage.observe('anthropic', 'two', h('0.18', '0.574'))
		// A key, however unused, waits behind the least-used subscription.
		expect(stats.plan(id, 'anthropic/claude-opus-5-5')).toEqual({ account: 2, accounts: 2, key: subscriptions.key('anthropic', 'two') })
		usage.observe('anthropic', 'two', h('0.3', '0.4'))
		expect(stats.plan(id, 'anthropic/claude-opus-5-5')!.key).toBe(subscriptions.key('anthropic', 'two'))
		expect(c.of('subscription-usage').at(-1).accounts[subscriptions.key('anthropic', 'two')]['5h'].used).toBe(30)
		// An idle client receives updates without another round or snapshot.
		let other = client()
		expect(other.of('tabs')[0].subscriptions[subscriptions.key('anthropic', 'two')]['5h'].used).toBe(30)
		usage.observe('anthropic', 'one', h('0.95', '0.55'))
		expect(other.of('subscription-usage').at(-1)).toEqual(c.of('subscription-usage').at(-1))
		expect(Object.keys(other.of('subscription-usage').at(-1).accounts)).toEqual([subscriptions.key('anthropic', 'one')])
		expect(stats.plan(id, 'fake/m1')).toBeUndefined()
	} finally {
		if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved
		usage.close()
		auth.close()
	}
})


test('each status read updates master quota and idle followers even when the previous reading is fresh', async () => {
	let credential = auth.credential, fetchOld = globalThis.fetch
	try {
		paths.init()
		writeFileSync(paths.authFile(), ason.stringify({ anthropic: [{ accessToken: 'token', email: 'sub@example.test' }] }), { mode: 0o600 })
		auth.credential = (async () => ({ type: 'token', value: 'token', account: 'sub@example.test' })) as typeof credential
		let c = client(), id = created(c), other = client()
		other.conn.send({ type: 'open', sessionId: id })
		usage.observe('anthropic', 'sub@example.test', new Headers({ 'anthropic-ratelimit-unified-5h-utilization': '0.95', 'anthropic-ratelimit-unified-7d-utilization': '0.4' }))
		let used = 24, reads = 0
		globalThis.fetch = (async () => { reads++; return Response.json({ five_hour: { utilization: used } }) }) as unknown as typeof fetch
		let key = subscriptions.key('anthropic', 'sub@example.test')
		expect(await statusUsage.show(id, 'anthropic/claude-opus-5-5')).toContain('24% used')
		expect(usage.windows('anthropic', 'sub@example.test')).toMatchObject({ '5h': { used: 24 } })
		expect(usage.windows('anthropic', 'sub@example.test')['7d']).toBeUndefined()
		expect(c.of('subscription-usage').at(-1).accounts[key]['5h'].used).toBe(24)
		expect(other.of('subscription-usage').at(-1)).toEqual(c.of('subscription-usage').at(-1))
		used = 25
		expect(await statusUsage.show(id, 'anthropic/claude-opus-5-5')).toContain('25% used')
		expect(reads).toBe(2)
		expect(other.of('subscription-usage').at(-1).accounts[key]['5h'].used).toBe(25)
	} finally {
		auth.credential = credential
		globalThis.fetch = fetchOld
		usage.close()
		auth.close()
	}
})
