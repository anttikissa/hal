import { expect, test } from 'bun:test'
import { calls, client, created, until, useHost } from '../host-fixture.test.ts'
import { prompts } from '../prompts.ts'

useHost()

test('/queue next runs a queued foreign message even when paused, retaining its sender', async () => {
	let a = client()
	let id = created(a)
	a.conn.send({ type: 'submit', sessionId: id, text: 'working' })
	await until(() => calls.length === 1)
	prompts.submit(id, 'foreign message', undefined, true, { from: '9-abc', label: 'helper' })
	a.conn.send({ type: 'pause', sessionId: id })
	await until(() => a.views.get(id)?.state.type === 'paused')
	a.conn.send({ type: 'submit', sessionId: id, text: '/queue next' })
	await until(() => calls.length === 2)
	expect(a.views.get(id)?.inbox).toEqual([])
	expect(a.views.get(id)?.items.find((i) => i.type === 'prompt' && i.text === 'foreign message')).toMatchObject({ from: '9-abc', label: 'helper' })
})
