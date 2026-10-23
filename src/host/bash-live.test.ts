import { expect, test } from 'bun:test'
import { client, created, fresh, calls, records, testHome, until, useHost } from './host-fixture.test.ts'
import { history } from './history.ts'

useHost()

test('foreground bash streams to every client, late snapshots match, final result replaces it', async () => {
	let first = client()
	let id = created(first, testHome())
	let watching = client()
	watching.conn.send({ type: 'open', sessionId: id })
	first.conn.send({ type: 'submit', sessionId: id, text: 'show progress' })
	await until(() => calls.length === 1)
	calls[0]!.push(
		{
			type: 'tool_call',
			id: 'b1',
			name: 'bash',
			input: { command: "printf 'first\\n'; sleep .3; printf 'last\\n'", description: 'Report progress' },
		},
		{ type: 'done', reason: 'tool_use' },
	)
	await until(() => first.of('tool-output').length > 0)
	let partial = first.views.get(id)!.items.find((item) => item.type === 'tool')
	expect(partial).toMatchObject({ partial: expect.stringContaining('first') })
	expect(watching.views.get(id)!.items).toEqual(first.views.get(id)!.items)
	expect((await fresh(id)).items).toEqual(first.views.get(id)!.items)
	expect((await records(id)).some((r) => r.type === 'user' && r.blocks.some((b) => b.type === 'tool_result'))).toBe(
		false,
	)
	for (let i = 0; i < 100 && !first.of('tool-results').length; i++) await Bun.sleep(20)
	expect(first.of('tool-results')).toHaveLength(1)
	let output = first.of('tool-results')[0].results[0].output
	expect(output).toContain('first\nlast\n')
	expect(first.views.get(id)!.items.find((item) => item.type === 'tool')).not.toHaveProperty('partial', 'first\n')
	expect(watching.views.get(id)!.items).toEqual(first.views.get(id)!.items)
	expect((await fresh(id)).items).toEqual(first.views.get(id)!.items)
	expect(
		history.readSync(id).filter((r) => r.type === 'user' && r.blocks.some((b) => b.type === 'tool_result')),
	).toHaveLength(1)
	calls[1]?.push({ type: 'done', reason: 'end' })
})

test('a background job streams apart from its unchanged call card until it ends (task 6nn)', async () => {
	let first = client()
	let id = created(first, testHome())
	first.conn.send({ type: 'submit', sessionId: id, text: 'run in background' })
	await until(() => calls.length === 1)
	calls[0]!.push(
		{
			type: 'tool_call',
			id: 'j1',
			name: 'bash',
			input: { command: "sleep .3; printf 'late\\n'; sleep .3", description: 'Report later', background: true },
		},
		{ type: 'done', reason: 'tool_use' },
	)
	await until(() => first.of('tool-results').length > 0)
	calls[1]?.push({ type: 'done', reason: 'end' })
	let call = () => first.views.get(id)!.items.find((item) => item.type === 'tool')!
	let before = call()
	await until(() => first.views.get(id)!.jobOutput?.j1?.output === 'late\n')
	expect(call()).toBe(before)
	expect(call()).not.toHaveProperty('partial')
	let late = await fresh(id)
	expect(late.jobOutput).toEqual(first.views.get(id)!.jobOutput)
	await until(() => !first.views.get(id)!.meta.background)
	expect(first.views.get(id)!.jobOutput).toBeUndefined()
	expect((await fresh(id)).jobOutput).toBeUndefined()
})
