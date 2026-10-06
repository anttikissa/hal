import { expect, test } from 'bun:test'
import { client, until, useHost } from '../host-fixture.test.ts'
import { commands } from '../commands.ts'
import { history } from '../history.ts'
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

test('/go reopens a closed session by id, name or directory', async () => {
	let a = client()
	let first = make(a, '/tmp/a')
	let gone = make(a, '/tmp/go-closed')
	sessions.open(gone).name = 'Gone'
	a.conn.send({ type: 'open', sessionId: first })
	for (let value of [gone, 'Gone', '/tmp/go-closed']) {
		a.conn.send({ type: 'tab-close', id: `close-${value}`, sessionId: gone })
		await until(() => !tabs.file().open.includes(gone))
		let count = a.of('go').length
		a.conn.send({ type: 'submit', sessionId: first, text: `/go ${value}` })
		await until(() => a.of('go').length > count)
		expect(a.of('go').at(-1)).toMatchObject({ sessionId: first, tab: gone })
		expect(tabs.file().open).toContain(gone)
	}
})

test('/go completion: one described row per session, directories, blocks newest first', () => {
	let c = client()
	let cwd = `${commands.home()}/hal-go-project`
	let id = make(c, cwd)
	let other = make(c, '/tmp/go-rows')
	sessions.open(other).name = 'Rows'
	history.append(id, { type: 'user', blocks: [{ type: 'text', text: 'first line\nsecond' }] })
	history.append(id, { type: 'assistant', block: { type: 'tool_call', id: 'c1', name: 'bash', input: { command: 'ls', description: 'List files' } } })
	let context = { sessionId: id, cwd: '/tmp', model: 'fake/m', setCwd() {}, setModel() {}, say() {} }
	let rows = (text: string) => commands.suggestions(text, context)
	expect(rows('/go ~/hal-go')).toEqual({ items: ['/go ~/hal-go-project'], descriptions: ['directory'] })
	let tabsRows = rows('/go ')
	expect(tabsRows.items).toEqual(tabs.list().map((_, i) => `/go ${i + 1}`))
	expect(tabsRows.descriptions![tabs.list().findIndex((t) => t.id === other)]).toBe(`Rows  ${other}`)
	expect(rows(`/go ${other.slice(0, 3)}`).items.filter((v) => v === `/go ${other}`)).toHaveLength(1)
	expect(rows('/go Ro')).toEqual({ items: [`/go ${other}`], descriptions: [expect.stringContaining('Rows')] })
	let blocks = rows('/go #')
	expect(blocks.items).toEqual(['/go #t2', '/go #u1'])
	expect(blocks.descriptions![0]).toEndWith('List files')
	expect(blocks.descriptions![1]).toEndWith('first line')
	expect(rows('/go t').items).toContain('/go #t2')
	expect(rows(`/go ${other}#`).items).toEqual([])
})

test('/go targets: n is a tab; #n, r12, #r12 and <session>#n, <session>/n are blocks; paths and names win', async () => {
	let a = client()
	let first = make(a, '/tmp/go-t')
	let second = make(a, '/tmp/go-t/4')
	sessions.open(second).name = 'Second'
	history.append(second, { type: 'user', blocks: [{ type: 'text', text: 'hi' }] })
	a.conn.send({ type: 'open', sessionId: first })
	await until(() => a.views.has(first))
	let go = async (value: string) => {
		let count = a.of('go').length
		a.conn.send({ type: 'submit', sessionId: first, text: `/go ${value}` })
		await until(() => a.of('go').length > count || a.of('output').at(-1)?.error)
		expect(a.of('go')).toHaveLength(count + 1)
		return a.of('go').at(-1)!
	}
	let n = history.readSync(second).at(-1)!.n
	expect(await go('2')).toMatchObject({ tab: second })
	expect((await go('2')).block).toBeUndefined()
	for (let value of [`2#${n}`, `2#t${n}`, `Second/${n}`, `${second}#u${n}`]) expect(await go(value)).toMatchObject({ tab: second, block: `u${n}` })
	// The path /tmp/go-t/4 is a session directory: it wins over tab 1's block 4.
	expect(await go('/tmp/go-t/4')).toMatchObject({ tab: second })
	expect((await go('/tmp/go-t/4')).block).toBeUndefined()
	sessions.open(second).name = 'r12'
	expect((await go('r12')).block).toBeUndefined()
	let before = a.of('go').length
	a.conn.send({ type: 'submit', sessionId: first, text: '/go #r999' })
	await until(() => a.of('output').some((o) => o.error && String(o.text).includes('#r999')))
	expect(a.of('go')).toHaveLength(before)
})

test('/go to a block of a closed session reopens it and carries the block', async () => {
	let a = client()
	let first = make(a, '/tmp/a')
	let gone = make(a, '/tmp/go-closed-block')
	history.append(gone, { type: 'user', blocks: [{ type: 'text', text: 'hi' }] })
	let n = history.readSync(gone).at(-1)!.n
	a.conn.send({ type: 'open', sessionId: first })
	a.conn.send({ type: 'tab-close', id: 'close-block', sessionId: gone })
	await until(() => !tabs.file().open.includes(gone))
	a.conn.send({ type: 'submit', sessionId: first, text: `/go ${gone}#${n}` })
	await until(() => a.of('go').at(-1)?.tab === gone)
	expect(a.of('go').at(-1)).toMatchObject({ block: `u${n}` })
	expect(tabs.file().open).toContain(gone)
})
