import { expect, test } from 'bun:test'
import { client, created, until, useHost } from '../host-fixture.test.ts'

useHost()

test('/mem shows memory and the open session; /mem gc shows before and after', async () => {
	let c = client()
	let id = created(c, '/tmp')
	c.conn.send({ type: 'submit', sessionId: id, text: '/mem' })
	await until(() => c.of('output').length === 1)
	let text: string = c.of('output')[0].text
	expect(text).toMatch(/rss +\d/)
	expect(text).toContain(`session ${id}`)
	c.conn.send({ type: 'submit', sessionId: id, text: '/mem gc' })
	await until(() => c.of('output').length === 2)
	expect(c.of('output')[1].text).toMatch(/before[\s\S]*after gc[\s\S]*rss/)
})
