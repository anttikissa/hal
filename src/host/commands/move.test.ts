import { expect, test } from 'bun:test'
import { client, restartHost, until, useHost } from '../host-fixture.test.ts'

useHost()

const order = (c: ReturnType<typeof client>) => c.of('tabs').at(-1).tabs.map((t: { id: string }) => t.id)
const tab = (c: ReturnType<typeof client>) => {
	c.conn.send({ type: 'tab-new', cwd: '/tmp/w', id: crypto.randomUUID() })
	return c.of('ack').at(-1).tab as string
}

test('/move changes the shared tab order at first, middle, and past the end; persists after restart', async () => {
	let a = client()
	let b = client()
	let [first, middle, last] = [tab(a), tab(a), tab(a)]
	a.conn.send({ type: 'open', sessionId: last })
	await until(() => a.views.has(last))
	let move = (text: string) => a.conn.send({ type: 'submit', sessionId: last, text })
	move('/move 1')
	await until(() => order(b)[0] === last)
	expect(order(a)).toEqual([last, first, middle])
	move('/move 2')
	await until(() => order(b)[1] === last)
	expect(order(a)).toEqual([first, last, middle])
	move('/move 100')
	await until(() => order(b)[2] === last)
	expect(order(a)).toEqual([first, middle, last])
	expect(a.views.has(last)).toBe(true)
	move('/move 0')
	await until(() => a.of('output').at(-1)?.error)
	expect(order(b)).toEqual([first, middle, last])
	restartHost()
	expect(order(client())).toEqual([first, middle, last])
})
