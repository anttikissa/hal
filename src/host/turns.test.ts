// Running turns (turns.ts): rounds, tools, pausing, failures and
// recovering unfinished turns on the next host.

import { expect, test } from 'bun:test'
import type { StreamEvent } from '../common/blocks.ts'
import { history } from './history.ts'
import { calls, client, created, fakeStream, fresh, readCall, records, restartHost, stamped, toolSession, until, useHost, shown } from './host-fixture.test.ts'
import { tools } from './tools.ts'
import { turns } from './turns.ts'

useHost()

test('pause stops the turn, keeping partial output, and continue carries it on', async () => {
	let a = client()
	let id = created(a)
	let b = client()
	b.conn.send({ type: 'open', sessionId: id })
	a.conn.send({ type: 'submit', sessionId: id, text: 'go' })
	await until(() => calls.length === 1)
	calls[0]!.push({ type: 'text', text: 'part' })
	await until(() => a.of('stream').length)
	expect(a.views.get(id)!.state).toEqual({ type: 'running', phase: 'streaming' })
	b.conn.send({ type: 'pause', sessionId: id })
	await until(() => a.of('turn-end').length)
	expect(a.of('turn-end')[0].status).toBe('paused')
	expect(a.views.get(id)!.state).toEqual({ type: 'paused' })
	let view = await fresh(id)
	expect(view).toEqual(a.views.get(id)!)
	expect(shown(view.items.slice(1))).toEqual([
		{ type: 'text', text: 'part' },
		{ type: 'turn-end', status: 'paused' },
	])
	// A new host does not continue a paused turn.
	restartHost()
	await turns.recover()
	expect(calls.length).toBe(1)
	a = client()
	a.conn.send({ type: 'open', sessionId: id })
	await until(() => a.views.get(id))
	expect(a.views.get(id)!.state).toEqual({ type: 'paused' })
	a.conn.send({ type: 'continue', sessionId: id })
	await until(() => calls.length === 2)
	expect(JSON.stringify(calls[1]!.input.messages.at(-1))).toContain('The user resumed the paused turn')
	calls[1]!.push({ type: 'text', text: 'rest' }, { type: 'done', reason: 'end' })
	await until(() => a.of('turn-end').length)
	expect(shown(a.views.get(id)!.items.slice(1))).toEqual([
		{ type: 'text', text: 'part' },
		{ type: 'turn-end', status: 'paused' },
		{ type: 'text', text: 'rest' },
		{ type: 'turn-end', status: 'completed' },
	])
	expect(await fresh(id)).toEqual(a.views.get(id)!)
})

test('continue is refused with nothing to continue; a provider error ends the turn and continue retries it', async () => {
	let a = client()
	let id = created(a)
	a.conn.send({ type: 'continue', sessionId: id })
	expect(a.of('rejected')[0]).toMatchObject({ command: 'continue', reason: expect.stringMatching(/nothing/) })
	a.conn.send({ type: 'pause', sessionId: id })
	expect(a.of('rejected')[1]).toMatchObject({ command: 'pause' })
	a.conn.send({ type: 'submit', sessionId: id, text: 'go' })
	await until(() => calls.length === 1)
	calls[0]!.push({ type: 'error', message: '400 bad request', status: 400 })
	await until(() => a.of('turn-end').length)
	expect(a.of('turn-end')[0]).toMatchObject({ status: 'error', error: '400 bad request' })
	expect(await fresh(id)).toEqual(a.views.get(id)!)
	expect(a.views.get(id)!.state).toEqual({ type: 'error', message: '400 bad request' })
	a.conn.send({ type: 'continue', sessionId: id })
	await until(() => calls.length === 2)
	expect(calls[1]!.input.messages[0]).toEqual({ role: 'user', blocks: [{ type: 'text', text: stamped('go') }] })
	expect(JSON.stringify(calls[1]!.input.messages.at(-1))).toContain('another attempt after the failed turn')
})

test('a stream that throws still ends the turn and frees the session', async () => {
	let a = client()
	let id = created(a)
	turns.stream = () => {
		throw new Error('boom')
	}
	a.conn.send({ type: 'submit', sessionId: id, text: 'go' })
	await until(() => a.of('turn-end').length)
	expect(a.of('turn-end')[0]).toMatchObject({ status: 'error', error: 'boom' })
	expect((await records(id)).at(-1)).toMatchObject({ type: 'turn_end', status: 'error', error: 'boom' })
	turns.stream = fakeStream
	a.conn.send({ type: 'submit', sessionId: id, text: 'again' })
	await until(() => calls.length === 1)
})

test('a tool call runs on the host and the turn continues with its result', async () => {
	let a = client()
	let id = toolSession(a)
	let b = client()
	b.conn.send({ type: 'open', sessionId: id })
	a.conn.send({ type: 'submit', sessionId: id, text: 'what did I note?' })
	await until(() => calls.length === 1)
	expect(calls[0]!.input.tools.map((t: any) => t.name)).toContain('read')
	calls[0]!.push({ type: 'text', text: 'Let me look.' }, readCall(), { type: 'usage', usage: { input: 10, output: 5 } }, { type: 'done', reason: 'tool_use' })
	await until(() => calls.length === 2)
	expect(calls[1]!.input.messages.slice(1)).toEqual([
		{
			role: 'assistant',
			blocks: [
				{ type: 'text', text: 'Let me look.' },
				{ type: 'tool_call', id: 't1', name: 'read', input: { path: 'notes.txt' } },
			],
		},
		{ role: 'user', blocks: [{ type: 'tool_result', id: 't1', output: 'remember the milk\n' }] },
	])
	// Still one turn: nobody has seen it end.
	expect(a.of('turn-end')).toEqual([])
	let late = client()
	late.conn.send({ type: 'open', sessionId: id })
	calls[1]!.push({ type: 'text', text: 'Milk.' }, { type: 'usage', usage: { input: 20, output: 1 } }, { type: 'done', reason: 'end' })
	await until(() => b.of('turn-end').length && late.of('turn-end').length)

	let view = await fresh(id)
	expect(shown(view.items)).toEqual([
		{ type: 'prompt', text: 'what did I note?' },
		{ type: 'text', text: 'Let me look.' },
		{ type: 'tool', id: 't1', name: 'read', input: { path: 'notes.txt' } },
		{ type: 'tool-result', id: 't1', output: 'remember the milk\n' },
		{ type: 'text', text: 'Milk.' },
		{ type: 'turn-end', status: 'completed', usage: { input: 30, output: 6 } },
	])
	expect(a.views.get(id)).toEqual(view)
	expect(b.views.get(id)).toEqual(view)
	expect(late.views.get(id)).toEqual(view)
	expect((await records(id)).filter((r) => r.type === 'turn_end')).toHaveLength(1)
})

test('a restart after a tool ran keeps its result, continues, and does not run it again', async () => {
	let ran = 0
	let origRun = tools.run
	tools.run = (...args) => (ran++, origRun(...args))
	try {
		let a = client()
		let id = toolSession(a)
		a.conn.send({ type: 'submit', sessionId: id, text: 'look' })
		await until(() => calls.length === 1)
		calls[0]!.push(readCall(), { type: 'done', reason: 'tool_use' })
		await until(() => calls.length === 2)
		expect(ran).toBe(1)
		// The host dies while the model answers the result.
		restartHost()
		await turns.recover()
		await until(() => calls.length === 3)
		// Results remain intact; the notice describes the host restart truthfully.
		expect(calls[2]!.input.messages.slice(0, calls[1]!.input.messages.length)).toEqual(calls[1]!.input.messages)
		expect(JSON.stringify(calls[2]!.input.messages.at(-1))).toContain('host restarted')
		calls[2]!.push({ type: 'text', text: 'milk' }, { type: 'done', reason: 'end' })
		await until(() => history.readSync(id).at(-1)?.type === 'turn_end')
		let view = await fresh(id)
		expect(shown(view.items.slice(-3))).toEqual([
			{ type: 'tool-result', id: 't1', output: 'remember the milk\n' },
			{ type: 'text', text: 'milk' },
			{ type: 'turn-end', status: 'completed' },
		])
		expect(ran).toBe(1)
	} finally {
		tools.run = origRun
	}
})

test('a tool call cut off by a restart is reported to the model, not run', async () => {
	let ran = 0
	let origRun = tools.run
	tools.run = (...args) => (ran++, origRun(...args))
	try {
		let a = client()
		let id = toolSession(a)
		a.conn.send({ type: 'submit', sessionId: id, text: 'look' })
		await until(() => calls.length === 1)
		calls[0]!.push(readCall())
		await until(() => a.of('stream').length === 1)
		restartHost()
		await turns.recover()
		await until(() => calls.length === 2)
		let result = calls[1]!.input.messages.at(-2).blocks[0]
		expect(result).toMatchObject({ type: 'tool_result', id: 't1', isError: true })
		expect(JSON.stringify(calls[1]!.input.messages.at(-1))).toContain('host restarted')
		expect(ran).toBe(0)
	} finally {
		tools.run = origRun
	}
})

test('a command cut off mid-run by a crash is never run again, and the model hears it may have run', async () => {
	let ran = 0
	let origRun = tools.run
	tools.run = () => (ran++, new Promise(() => {}))
	try {
		let a = client()
		let id = toolSession(a)
		a.conn.send({ type: 'submit', sessionId: id, text: 'clean up' })
		await until(() => calls.length === 1)
		let rm: StreamEvent = { type: 'tool_call', id: 'b1', name: 'bash', input: { command: 'rm notes.txt', description: 'Delete the notes' } }
		calls[0]!.push(rm, { type: 'done', reason: 'tool_use' })
		await until(() => ran === 1)
		restartHost()
		await turns.recover()
		await until(() => calls.length === 2)
		let [result] = calls[1]!.input.messages.at(-2).blocks
		expect(result).toMatchObject({ type: 'tool_result', id: 'b1', isError: true })
		expect(result.output).toMatch(/may or may not have run/)
		expect(ran).toBe(1)
	} finally {
		tools.run = origRun
	}
})
