import { expect, test } from 'bun:test'
import { client, created, until, useHost } from '../host-fixture.test.ts'
import { tabs } from '../tabs.ts'

useHost()

test('/broadcast and /send all deliver to every other open tab, not sender; no others reports it', async () => {
	let c = client(), sender = created(c)
	let submit = (text: string) => c.conn.send({ type: 'submit', sessionId: sender, text })
	tabs.insert(sender, 0)
	submit('/broadcast nobody')
	await until(() => c.of('output').at(-1)?.text?.includes('no other open sessions'))
	let a = created(c), b = created(c)
	tabs.insert(a, 1); tabs.insert(b, 2)
	submit('/broadcast first hello')
	await until(() => c.views.get(a)?.items.some((i) => i.type === 'prompt' && i.text === 'first hello') && c.views.get(b)?.items.some((i) => i.type === 'prompt' && i.text === 'first hello'))
	for (let id of [a, b]) expect(c.views.get(id)?.items.find((i) => i.type === 'prompt')).toMatchObject({ from: sender, text: 'first hello' })
	expect(c.views.get(sender)?.items.some((i) => i.type === 'prompt')).toBe(false)
	submit('/send all another hello')
	await until(() => [a, b].every((id) => c.views.get(id)?.inbox.some((i) => i.text === 'another hello')))
	for (let id of [a, b]) expect(c.views.get(id)?.inbox[0]).toMatchObject({ from: sender, text: 'another hello' })
	expect(c.views.get(sender)?.inbox).toEqual([])
})
