import { expect, test } from 'bun:test'
import { client, created, fresh, restartHost, until, useHost } from '../host-fixture.test.ts'

useHost()

test('/blocks sets, resets and persists the session start states and refuses unknown ones', async () => {
	let a = client()
	let id = created(a)
	let b = client()
	b.conn.send({ type: 'open', sessionId: id })
	await until(() => b.views.has(id))
	let send = (text: string) => a.conn.send({ type: 'submit', sessionId: id, text })
	send('/blocks tool long')
	await until(() => b.views.get(id)?.meta.blocks?.tool === 'long')
	send('/blocks thinking sometimes')
	await until(() => a.of('output').at(-1)?.error)
	expect(a.of('output').at(-1)?.text).toContain('usage: /blocks')
	send('/blocks thinking glimpse')
	await until(() => b.views.get(id)?.meta.blocks?.thinking === 'glimpse')
	send('/blocks tool default')
	await until(() => b.views.get(id)?.meta.blocks?.tool === undefined)
	restartHost()
	expect((await fresh(id)).meta.blocks).toEqual({ thinking: 'glimpse' })
})
