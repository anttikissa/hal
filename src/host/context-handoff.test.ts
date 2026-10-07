// Immediate context changes reuse hard steering without changing inbox or tool policy.
// Task: 6eq.
import { expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'fs'
import { calls, client, created, fresh, testHome, until, useHost } from './host-fixture.test.ts'
import { history } from './history.ts'
import { slash } from './slash.ts'
import { tools } from './tools.ts'
import { turns } from './turns.ts'

useHost()

for (let delivery of ['soft-steer', 'steer'] as const) test(`/cd interrupts with ${delivery}, refreshes instructions and leaves queued messages queued`, async () => {
	let c = client(), home = testHome(), id = created(c, home)
	mkdirSync(`${home}/sub`)
	writeFileSync(`${home}/sub/AGENTS.md`, 'Respond in Finnish.')
	c.conn.send({ type: 'submit', sessionId: id, text: 'Write a poem.' })
	await until(() => calls.length === 1)
	calls[0]!.push({ type: 'text', text: 'Summer light' })
	await until(() => c.of('stream').length)
	let signal = turns.state.running.get(id)!.controller.signal
	c.conn.send({ type: 'submit', sessionId: id, text: 'Later task.', delivery: 'queue' })
	c.conn.send({ type: 'submit', sessionId: id, text: '/cd sub', delivery })
	expect(signal.aborted).toBe(true)
	await until(() => calls.length === 2)
	expect(calls[1]!.input.system).toContain('Respond in Finnish.')
	expect(calls[1]!.input.system).toContain(`${home}/sub`)
	let input = JSON.stringify(calls[1]!.input.messages)
	expect(input).toContain('Summer light')
	expect(input).toContain('Continue your unfinished response')
	expect(input).not.toContain('Later task.')
	expect(c.views.get(id)!.inbox.map((m) => m.text)).toEqual(['Later task.'])
	let items = c.views.get(id)!.items
	expect(items.findIndex((i) => i.type === 'text' && i.text === 'Summer light')).toBeLessThan(items.findIndex((i) => i.type === 'output' && i.text.includes('Directory changed:')))
	c.conn.send({ type: 'pause', sessionId: id })
	await until(() => c.of('turn-end').length)
	expect(await fresh(id)).toEqual(c.views.get(id)!)
})

test('invalid and unchanged settings do not interrupt; changes do not override a pause during settlement', async () => {
	let c = client(), home = testHome(), id = created(c, home)
	c.conn.send({ type: 'submit', sessionId: id, text: 'go' })
	await until(() => calls.length === 1)
	let signal = turns.state.running.get(id)!.controller.signal
	for (let text of ['/cd .', '/model invalid-provider/model']) {
		let n = c.of('output').length
		c.conn.send({ type: 'submit', sessionId: id, text })
		await until(() => c.of('output').length > n)
		expect(signal.aborted).toBe(false)
	}
	slash.change(id, { model: 'fake/m1' })
	expect(signal.aborted).toBe(false)
	c.conn.send({ type: 'pause', sessionId: id })
	slash.change(id, { model: 'fake/m2' })
	await until(() => c.of('turn-end').length)
	expect(calls).toHaveLength(1)
	expect(c.views.get(id)!.state.type).toBe('paused')
	expect(history.readSync(id).some((r) => r.type === 'notice' && r.text.includes('Continue your unfinished response'))).toBe(false)
})

test('model handoff lets unsafe work settle once and cancels undispatched calls', async () => {
	let finish!: () => void
	let settled = new Promise<void>((resolve) => { finish = resolve })
	let original = tools.run, signal: AbortSignal | undefined, dispatched: string[] = []
	tools.run = async (call, ctx) => {
		dispatched.push(call.id)
		signal = ctx.signal
		await settled
		return { type: 'tool_result', id: call.id, output: 'Migration finished.' }
	}
	try {
		let c = client(), id = created(c)
		c.conn.send({ type: 'submit', sessionId: id, text: 'Migrate.' })
		await until(() => calls.length === 1)
		calls[0]!.push(
			{ type: 'tool_call', id: 'migration', name: 'bash', input: { command: 'migrate', unsafeToStop: true } },
			{ type: 'tool_call', id: 'pending', name: 'bash', input: { command: 'do not run' } },
			{ type: 'done', reason: 'tool_use' },
		)
		await until(() => dispatched.length)
		slash.change(id, { model: 'other/m2' })
		expect(signal!.aborted).toBe(false)
		expect(calls).toHaveLength(1)
		finish()
		await until(() => calls.length === 2)
		expect(calls[1]!.model).toBe('other/m2')
		let blocks = calls[1]!.input.messages.flatMap((m: any) => m.blocks)
		expect(blocks).toContainEqual({ type: 'tool_result', id: 'migration', output: 'Migration finished.' })
		expect(blocks).toContainEqual({ type: 'tool_result', id: 'pending', output: expect.stringContaining('did not run'), interrupted: 'canceled' })
		expect(dispatched).toEqual(['migration'])
		calls[1]!.push({ type: 'done', reason: 'end' })
		await until(() => c.of('turn-end').length)
	} finally { finish(); tools.run = original }
})
