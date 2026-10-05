import { expect, test } from 'bun:test'
import { calls, client, created, fakeStream, fresh, records, stamped, until, useHost } from './host-fixture.test.ts'
import { history } from './history.ts'
import { prompts } from './prompts.ts'
import { tools } from './tools.ts'
import { turns } from './turns.ts'
import { tabs } from './tabs.ts'

useHost()

function gate() {
	let release!: () => void
	let promise = new Promise<void>((resolve) => { release = resolve })
	return { promise, release }
}

test('durable receipt aborts a provider; late tool calls cannot dispatch before settlement', async () => {
	let settling = gate()
	let signal: AbortSignal | undefined
	let original = tools.run
	let dispatched: string[] = []
	tools.run = async (call) => { dispatched.push(call.id); return { type: 'tool_result', id: call.id, output: 'ran' } }
	let requests = 0
	turns.stream = (model, input, current) => {
		if (requests++) return fakeStream(model, input, current)
		signal = current
		return (async function* () {
			yield { type: 'text' as const, text: 'partial' }
			await settling.promise // Deliberately slow provider cleanup.
			yield { type: 'tool_call' as const, id: 'late', name: 'bash', input: { command: 'must not run' } }
			yield { type: 'done' as const, reason: 'tool_use' as const }
		})()
	}
	try {
		let a = client()
		let id = created(a)
		a.conn.send({ type: 'submit', sessionId: id, text: 'go' })
		await until(() => a.of('stream').length)
		let durableAtAbort = false
		signal!.addEventListener('abort', () => { durableAtAbort = history.readSync(id).some((r) => r.type === 'inbox' && r.id === 's1') })
		a.conn.send({ type: 'submit', sessionId: id, text: 'stop', id: 's1' })
		a.conn.send({ type: 'submit', sessionId: id, text: 'instead do this', id: 's2' })
		expect(signal!.aborted).toBe(true)
		expect(durableAtAbort).toBe(true)
		expect(requests).toBe(1)
		settling.release()
		await until(() => calls.length === 1)
		expect(dispatched).toEqual([])
		expect(calls[0]!.input.messages.at(-1).blocks.at(-1).text).toEqual(stamped('stop\n\ninstead do this'))
		expect((await records(id)).some((r) => r.type === 'assistant' && r.block.type === 'text' && r.block.text === 'partial')).toBe(true)
		calls[0]!.push({ type: 'done', reason: 'end' })
		await until(() => a.of('turn-end').length)
		expect(await fresh(id)).toEqual(a.views.get(id)!)
	} finally { settling.release(); tools.run = original }
})

for (let stop of ['none', 'pause', 'close'] as const) {
	test(`foreground tools settle and pending commands stay suppressed; ${stop} controls restart`, async () => {
		let settling = gate()
		let original = tools.run
		let dispatched: string[] = []
		let toolSignal: AbortSignal | undefined
		tools.run = async (call, ctx) => {
			dispatched.push(call.id)
			toolSignal = ctx.signal
			await settling.promise
			return { type: 'tool_result', id: call.id, output: 'settled partial output' }
		}
		try {
			let a = client()
			let id = created(a)
			if (stop === 'close') { tabs.insert(id, 0); tabs.insert(created(a), 1) }
			a.conn.send({ type: 'submit', sessionId: id, text: 'go' })
			await until(() => calls.length === 1)
			calls[0]!.push(
				{ type: 'tool_call', id: 'first', name: 'bash', input: { command: 'first' } },
				{ type: 'tool_call', id: 'pending', name: 'bash', input: { command: 'must not run' } },
				{ type: 'done', reason: 'tool_use' },
			)
			await until(() => dispatched.length)
			a.conn.send({ type: 'submit', sessionId: id, text: 'one' })
			a.conn.send({ type: 'submit', sessionId: id, text: 'two' })
			expect(toolSignal!.aborted).toBe(true)
			expect(calls.length).toBe(1)
			if (stop === 'pause') a.conn.send({ type: 'pause', sessionId: id })
			if (stop === 'close') a.conn.send({ type: 'tab-close', sessionId: id })
			settling.release()
			if (stop === 'none') {
				await until(() => calls.length === 2)
				let blocks = calls[1]!.input.messages.flatMap((m: any) => m.blocks)
				expect(blocks).toContainEqual({ type: 'tool_result', id: 'first', output: 'settled partial output' })
				expect(blocks).toContainEqual({ type: 'tool_result', id: 'pending', output: expect.stringContaining('did not run'), interrupted: 'cancelled' })
				calls[1]!.push({ type: 'done', reason: 'end' })
			}
			await until(() => a.of('turn-end').length)
			expect(dispatched).toEqual(['first'])
			if (stop !== 'none') {
				expect(calls.length).toBe(1)
				expect(a.views.get(id)!.state.type).toBe('paused')
				expect(a.views.get(id)!.inbox.map((m) => m.text)).toEqual(['one', 'two'])
			}
		} finally { settling.release(); tools.run = original }
	})
}

test('queue and advisory do not abort, while explicit steer does', async () => {
	let a = client()
	let id = created(a)
	a.conn.send({ type: 'submit', sessionId: id, text: 'go' })
	await until(() => calls.length === 1)
	let signal = turns.state.running.get(id)!.controller.signal
	a.conn.send({ type: 'submit', sessionId: id, text: 'later', queue: true })
	prompts.submit(id, 'advice', undefined, false, { from: 'peer', advisory: true })
	expect(signal.aborted).toBe(false)
	prompts.submit(id, 'steer', undefined, false, { from: 'peer' })
	expect(signal.aborted).toBe(true)
	await until(() => calls.length === 2)
	calls[1]!.push({ type: 'done', reason: 'end' })
	await until(() => calls.length === 3)
	calls[2]!.push({ type: 'done', reason: 'end' })
	await until(() => a.views.get(id)!.state.type === 'idle')
})

for (let escape of [false, true]) {
	test(`steering waits for an unsafeToStop call, then cancels the rest${escape ? '; Escape still stops it' : ''}`, async () => {
		let settling = gate()
		let original = tools.run
		let dispatched: string[] = []
		let toolSignal: AbortSignal | undefined
		tools.run = async (call, ctx) => {
			dispatched.push(call.id)
			toolSignal = ctx.signal
			await settling.promise
			return { type: 'tool_result', id: call.id, output: 'migrated' }
		}
		try {
			let a = client()
			let id = created(a)
			a.conn.send({ type: 'submit', sessionId: id, text: 'go' })
			await until(() => calls.length === 1)
			calls[0]!.push(
				{ type: 'tool_call', id: 'flagged', name: 'bash', input: { command: 'migrate', description: 'Migrate', unsafeToStop: true } },
				{ type: 'tool_call', id: 'pending', name: 'bash', input: { command: 'must not run' } },
				{ type: 'done', reason: 'tool_use' },
			)
			await until(() => dispatched.length)
			a.conn.send({ type: 'submit', sessionId: id, text: 'steer' })
			expect(toolSignal!.aborted).toBe(false)
			expect(a.views.get(id)!.inbox.map((m) => m.text)).toEqual(['steer'])
			if (escape) {
				a.conn.send({ type: 'pause', sessionId: id })
				expect(toolSignal!.aborted).toBe(true)
			}
			settling.release()
			if (!escape) {
				await until(() => calls.length === 2)
				let messages = calls[1]!.input.messages
				expect(messages.flatMap((m: any) => m.blocks)).toContainEqual({ type: 'tool_result', id: 'flagged', output: 'migrated' })
				expect(messages.flatMap((m: any) => m.blocks)).toContainEqual({ type: 'tool_result', id: 'pending', output: expect.stringContaining('did not run'), interrupted: 'cancelled' })
				expect(messages.at(-1).blocks.at(-1).text).toEqual(stamped('steer'))
				calls[1]!.push({ type: 'done', reason: 'end' })
			}
			await until(() => a.of('turn-end').length)
			expect(dispatched).toEqual(['flagged'])
			if (escape) expect(a.views.get(id)!.state.type).toBe('paused')
		} finally { settling.release(); tools.run = original }
	})
}
