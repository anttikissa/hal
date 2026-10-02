import { expect, test } from 'bun:test'
import { calls, client, created, until, useHost } from '../host-fixture.test.ts'
import { push } from '../push.ts'
import { tools } from '../tools.ts'

useHost()

const run = (id: string, input: Record<string, unknown>) => tools.run({ type: 'tool_call', id: 'n', name: 'notify', input }, { sessionId: id, cwd: '/tmp', signal: new AbortController().signal })

test('mid-turn notify uses watch routing and the provider goes on after sent', async () => {
	let c = client(), id = created(c), other = created(c)
	let pushed: string[] = []
	let original = push.notify
	push.notify = async (_id, _name, text) => void pushed.push(text)
	try {
		c.conn.send({ type: 'visibility', sessionId: id, visible: true })
		expect((await run(id, { text: 'Watched' })).output).toBe('sent')
		expect(c.of('notice')).toEqual([])
		expect(pushed).toEqual([])
		c.conn.send({ type: 'visibility', sessionId: other, visible: true })
		c.conn.send({ type: 'submit', sessionId: id, text: 'go' })
		await until(() => calls.length)
		calls.shift()!.push({ type: 'tool_call', id: 'mid', name: 'notify', input: { text: 'The first approach failed' } }, { type: 'done', reason: 'tool_use' })
		await until(() => calls.length)
		expect(c.of('notice').at(-1)).toMatchObject({ session: id, kind: 'update', line: 'The first approach failed' })
		expect(c.of('tool-results').at(-1).results[0].output).toBe('sent')
		expect(c.of('turn-end')).toEqual([])
		calls.shift()!.push({ type: 'text', text: 'Trying another approach' }, { type: 'done', reason: 'end' })
		await until(() => c.of('turn-end').length)
		expect(pushed).toEqual([])
		c.conn.send({ type: 'visibility', sessionId: other, visible: false })
		await run(id, { text: 'Nobody watching' })
		expect(pushed).toEqual(['Nobody watching'])
	} finally {
		push.notify = original
	}
})

test('notify refuses invalid text before delivering anything', async () => {
	let c = client(), id = created(c), other = created(c)
	c.conn.send({ type: 'visibility', sessionId: other, visible: true })
	for (let input of [{ text: 'x'.repeat(80) }, { text: '' }, { text: '\nhello' }, { text: 1 }, { text: 'ok', other: true }]) {
		expect((await run(id, input)).isError).toBe(true)
	}
	expect(c.of('notice')).toEqual([])
	expect((await run(id, { text: 'x'.repeat(79) })).isError).toBeUndefined()
	expect(c.of('notice')).toHaveLength(1)
})
