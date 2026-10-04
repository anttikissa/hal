import { expect, test } from 'bun:test'
import { client, calls, created, restartHost, until, useHost } from './host-fixture.test.ts'
import { sessions } from './sessions.ts'
import { naming } from './naming.ts'
import { history } from './history.ts'
import { names } from '../common/names.ts'

useHost(true)

test('absent model rename keeps placeholder and legacy backfill never copies a prompt', async () => {
	let c = client(), id = created(c)
	naming.manual(id)
	c.conn.send({ type: 'submit', sessionId: id, text: 'A long first request that must never become a session title' })
	await until(() => calls.length > 0)
	calls[0]!.push({ type: 'text', text: 'Done.' }, { type: 'done', reason: 'end' })
	await until(() => !history.state.running.has(id))
	c.conn.send({ type: 'submit', sessionId: id, text: '/rename backfill' })
	await until(() => c.of('output').some((e) => e.text.includes('backfill')))
	expect(sessions.open(id).name).toBe(names.fallback(id))
	restartHost()
	expect(sessions.open(id).name).toBe(names.fallback(id))
})
