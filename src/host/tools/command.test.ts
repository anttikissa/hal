import { expect, test } from 'bun:test'
import { calls, client, created, records, testHome, until, useHost } from '../host-fixture.test.ts'
import { tools } from '../tools.ts'
import { tabs } from '../tabs.ts'
import { sessions } from '../sessions.ts'

useHost()

const run = (sessionId: string, command: unknown, signal = new AbortController().signal) => tools.run(
	{ type: 'tool_call', id: crypto.randomUUID(), name: 'command', input: { command } },
	{ cwd: testHome(), signal, sessionId },
)

test('model commands use the same slash path as typed commands, including state, output and errors', async () => {
	let a = client()
	let id = created(a, testHome())
	let b = client()
	b.conn.send({ type: 'open', sessionId: id })
	await until(() => b.views.has(id))
	let renamed = await run(id, '/rename Work in progress')
	expect(renamed.output).toBe(`Session renamed: Session ${id} → Work in progress`)
	expect(a.of('command').at(-1).origin).toBe('model')
	expect((await records(id)).find((r) => r.type === 'command')).toMatchObject({ origin: 'model' })
	expect(a.of('output').at(-1).ts).toBeString()
	expect(sessions.open(id).name).toBe('Work in progress')
	expect(b.of('meta').at(-1).meta.name).toBe('Work in progress')
	let cwd = await run(id, '/cd .')
	expect(cwd.output).toContain(testHome())
	expect((await run(id, '/cd /dev/null')).isError).toBe(true)
	expect(sessions.open(id).cwd).toBe(testHome())
	expect((await records(id)).filter((r) => r.type === 'command').map((r: any) => r.text)).toEqual(['/rename Work in progress', '/cd .', '/cd /dev/null'])
	expect(a.of('output').at(-1).error).toBe(true)
	a.conn.send({ type: 'submit', sessionId: id, text: '/rename Human title' })
	await until(() => sessions.open(id).name === 'Human title')
	expect(a.of('command').at(-1).origin).toBeUndefined()
	expect(a.of('output').at(-1).text).toBe('Session renamed: Work in progress → Human title')
})

test('a model tool call can /go and /rename while its turn runs; results reach the next provider round', async () => {
	let a = client()
	let id = created(a, testHome())
	a.conn.send({ type: 'tab-new', cwd: testHome(), id: crypto.randomUUID() })
	let target = a.of('ack').at(-1).tab as string
	tabs.file().open.push(id)
	a.conn.send({ type: 'submit', sessionId: id, text: 'Switch our tab' })
	await until(() => calls.length === 1)
	calls[0]!.push({ type: 'tool_call', id: 't1', name: 'command', input: { command: `/go ${target}` } }, { type: 'tool_call', id: 't2', name: 'command', input: { command: '/rename New name' } }, { type: 'done', reason: 'tool_use' })
	await until(() => calls.length === 2)
	expect(a.of('go').at(-1).tab).toBe(target)
	expect(sessions.open(id).name).toBe('New name')
	let results = calls[1]!.input.messages.flatMap((m: any) => m.blocks).filter((b: any) => b.type === 'tool_result')
	expect(results).toEqual([{ type: 'tool_result', id: 't1', output: '/go done' }, { type: 'tool_result', id: 't2', output: `Session renamed: Session ${id} → New name` }])
	calls[1]!.push({ type: 'done', reason: 'end' })
	await until(() => a.of('turn-end').length)
})

test('unsafe, unknown and malformed commands are rejected without recording or executing them', async () => {
	let a = client()
	let id = created(a, testHome())
	for (let command of ['/login chatgpt', '/auth', '/auth revoke', '/quit', '/restart', '/budget 100', '/send 1 secret', '/pause', '/unknown', 'rename hidden', 17]) {
		let result = await run(id, command)
		expect(result.isError).toBe(true)
	}
	let ac = new AbortController()
	ac.abort()
	expect((await run(id, '/rename Hidden', ac.signal)).isError).toBe(true)
	expect(sessions.open(id).name).toContain(id)
	expect((await records(id)).filter((r) => r.type === 'command')).toEqual([])
})
