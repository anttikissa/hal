import { expect, test } from 'bun:test'
import { client, created, until, useHost } from '../host-fixture.test.ts'
import { sessions } from '../sessions.ts'
import { settings } from '../../common/settings.ts'

useHost()

test('/budget shows default, sets and adjusts slots, rejecting invalid or negative values without changing them', async () => {
	let c = client(), id = created(c)
	let submit = async (text: string) => {
		let count = c.of('output').length
		c.conn.send({ type: 'submit', sessionId: id, text })
		await until(() => c.of('output').length > count)
		return c.of('output').at(-1)
	}
	expect((await submit('/budget')).text).toContain(`${settings.subagentSlots()} spawn slots`)
	expect((await submit('/budget 5')).text).toContain('5 spawn slots')
	expect((await submit('/budget +3')).text).toContain('8 spawn slots')
	expect((await submit('/budget -7')).text).toContain('1 spawn slot')
	for (let text of ['/budget -2', '/budget nope', '/budget 2.5', '/budget 999999999999999999999']) expect((await submit(text)).error).toBe(true)
	expect(sessions.open(id).slots).toBe(1)
	let other = created(c)
	c.conn.send({ type: 'submit', sessionId: other, text: `/send ${id} /budget 99` })
	await until(() => c.of('output').some((o) => o.error && o.text?.includes('only a human can run /budget')))
	expect(sessions.open(id).slots).toBe(1)
})
