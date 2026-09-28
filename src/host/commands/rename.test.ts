import { expect, test } from 'bun:test'
import { client, created, fresh, restartHost, until, useHost } from '../host-fixture.test.ts'

useHost()

test('/rename broadcasts to followers and tabs, clears, refuses invalid names, survives restart', async () => {
	let a = client()
	let id = created(a)
	let b = client()
	b.conn.send({ type: 'open', sessionId: id })
	await until(() => b.views.has(id))
	let send = (text: string) => a.conn.send({ type: 'submit', sessionId: id, text })
	send('/rename   Alpha project  ')
	await until(() => b.views.get(id)?.meta.name === 'Alpha project')
	expect(a.views.get(id)?.meta.name).toBe('Alpha project')
	send(`/rename ${'x'.repeat(61)}`)
	await until(() => b.of('output').at(-1)?.error)
	expect(b.views.get(id)?.meta.name).toBe('Alpha project')
	expect(b.of('output').at(-1)?.text).toContain('60')
	send('/rename')
	await until(() => b.views.get(id)?.meta.name === undefined)
	expect((await fresh(id)).meta.name).toBeUndefined()
	send('/rename Persisted')
	await until(() => b.views.get(id)?.meta.name === 'Persisted')
	restartHost()
	expect((await fresh(id)).meta.name).toBe('Persisted')
})
