// The status row's numbers the host sends (stats.ts, task 1g).

import { expect, test } from 'bun:test'
import { writeFileSync } from 'fs'
import { ason } from '../common/ason.ts'
import { calls, client, created, fresh, restartHost, until, useHost } from './host-fixture.test.ts'
import { auth } from './auth.ts'
import { models } from './models.ts'
import { paths } from './paths.ts'
import { stats } from './stats.ts'
import { usage } from './usage.ts'

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

test('turn ends carry this run’s token totals and the last round’s context; a new host keeps only the context', async () => {
	let c = client()
	let id = created(c)
	expect(c.of('snapshot').at(-1).snapshot.stats).toEqual({ sent: 0, received: 0 })
	// Two rounds: the context is the last round's intake, cache included.
	expect(await turn(c, id, { input: 900, output: 10 }, { input: 50, cacheRead: 1000, output: 20 })).toEqual({ sent: 950, received: 30, context: 1050 })
	expect(await turn(c, id, { input: 7, cacheRead: 2000, output: 5 })).toEqual({ sent: 957, received: 35, context: 2007 })
	expect((await fresh(id)).stats).toEqual({ sent: 957, received: 35, context: 2007 })
	restartHost()
	expect((await fresh(id)).stats).toEqual({ sent: 0, received: 0, context: 2007 })
})

test('stats rise after a provider round while tools run, then change on the next round without double counting', async () => {
	let c = client(), id = created(c)
	c.conn.send({ type: 'submit', sessionId: id, text: 'go' })
	await until(() => calls.length === 1)
	calls[0]!.push({ type: 'tool_call', id: 't1', name: 'nope', input: {} }, { type: 'usage', usage: { input: 900, output: 5 } }, { type: 'done', reason: 'tool_use' })
	await until(() => calls.length === 2)
	expect(c.of('turn-end')).toHaveLength(0)
	expect(c.views.get(id)!.stats).toMatchObject({ sent: 900, received: 5, context: 900 })
	calls[1]!.push({ type: 'usage', usage: { input: 50, cacheRead: 1000, output: 20 } }, { type: 'done', reason: 'end' })
	await until(() => c.of('turn-end').length)
	expect(c.of('turn-stats').map((event) => event.stats.context)).toEqual([900, 1050])
	expect(c.views.get(id)!.stats).toMatchObject({ sent: 950, received: 25, context: 1050 })
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
		writeFileSync(paths.authFile(), ason.stringify({ anthropic: [{ accessToken: 'a', email: 'one' }, { accessToken: 'b', email: 'two' }, { apiKey: 'k' }] }), { mode: 0o600 })
		let h = (u5: string, u7: string) => new Headers({ 'anthropic-ratelimit-unified-5h-utilization': u5, 'anthropic-ratelimit-unified-7d-utilization': u7 })
		usage.observe('anthropic', 'one', h('0.9', '0.5'))
		usage.observe('anthropic', 'two', h('0.18', '0.574'))
		// A key, however unused, waits behind the least-used subscription.
		expect(stats.plan(id, 'anthropic/claude-opus-5-5')).toEqual({ account: 2, accounts: 2, windows: { '5h': 18, '7d': 57 } })
		usage.observe('anthropic', 'two', h('0.3', '0.4'))
		expect(stats.plan(id, 'anthropic/claude-opus-5-5')!.windows).toEqual({ '5h': 18, '7d': 57 })
		stats.state.windows.get('anthropic:two')!.at -= 60_000
		expect(stats.plan(id, 'anthropic/claude-opus-5-5')!.windows).toEqual({ '5h': 30, '7d': 40 })
		expect(stats.plan(id, 'fake/m1')).toBeUndefined()
	} finally {
		if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved
		usage.close()
		auth.close()
	}
})
