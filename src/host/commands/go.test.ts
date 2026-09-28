import { expect, test } from 'bun:test'
import { client, until, useHost } from '../host-fixture.test.ts'
import { commands } from '../commands.ts'
import { sessions } from '../sessions.ts'
import { tabs } from '../tabs.ts'

useHost()

let sequence = 0
const make = (c: ReturnType<typeof client>, cwd: string) => {
	let id = `go-${++sequence}`
	c.conn.send({ type: 'tab-new', id, cwd })
	return (c.events.find((e) => e.type === 'ack' && e.id === id) as { tab: string }).tab
}

test('/go resolves number, id, name and first open tab in a directory; only followers hear it', async () => {
	let a = client()
	let first = make(a, '/tmp/a')
	let second = make(a, '/tmp/b')
	let third = make(a, '/tmp/b')
	sessions.open(second).name = 'Target'
	let watcher = client()
	let other = client()
	a.conn.send({ type: 'open', sessionId: first })
	watcher.conn.send({ type: 'open', sessionId: first })
	other.conn.send({ type: 'open', sessionId: third })
	await until(() => watcher.views.has(first) && other.views.has(third))
	let go = async (value: string, target: string) => {
		a.conn.send({ type: 'submit', sessionId: first, text: `/go ${value}` })
		await until(() => watcher.of('go').at(-1)?.tab === target)
		expect(a.of('go').at(-1)).toMatchObject({ sessionId: first, tab: target })
		expect(other.of('go')).toHaveLength(0)
	}
	await go('2', second)
	await go(third, third)
	await go('Target', second)
	await go('/tmp/b', second)
	a.conn.send({ type: 'submit', sessionId: first, text: '/go absent' })
	await until(() => a.of('output').at(-1)?.error)
	expect(a.of('go')).toHaveLength(4)
	expect(tabs.file().open).toEqual([first, second, third])
})

test('/go completion uses open tabs and cwd, abbreviating home directories', () => {
	let c = client()
	let cwd = `${commands.home()}/hal-go-project`
	let id = make(c, cwd)
	let context = { sessionId: id, cwd: '/tmp', model: 'fake/m', setCwd() {}, setModel() {}, say() {} }
	expect(commands.complete('/go ~/hal-go', context)).toContain('/go ~/hal-go-project')
	expect(commands.complete('/go 1', context)).toContain('/go 1')
	expect(commands.complete(`/go ${id.slice(0, 2)}`, context)).toContain(`/go ${id}`)
})
