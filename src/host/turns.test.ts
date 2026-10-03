// Running turns (turns.ts): rounds, tools, pausing, failures and
// recovering unfinished turns on the next host.

import { expect, test } from 'bun:test'
import type { StreamEvent } from '../common/blocks.ts'
import { replay } from '../common/replay.ts'
import { states } from '../common/states.ts'
import type { Shown as Item } from '../common/transcript.ts'
import { titles } from '../common/titles.ts'
import { history } from './history.ts'
import { calls, client, created, fakeStream, fresh, readCall, records, restartHost, stamped, toolSession, until, useHost, shown } from './host-fixture.test.ts'
import { host } from './host.ts'
import { tools } from './tools.ts'
import { turns } from './turns.ts'

useHost()

// Task hp: a block's header is right from its first streamed byte:
// what a client shows mid-stream is what the saved record replays.
test('a streaming block has its final header from the first event on', async () => {
	let a = client()
	let id = created(a)
	a.conn.send({ type: 'submit', sessionId: id, text: 'hi' })
	await until(() => calls.length === 1)
	calls[0]!.push({ type: 'thinking', text: 'h' })
	await until(() => a.views.get(id)!.items.some((i) => i.type === 'thinking'))
	let heads = () => a.views.get(id)!.items.filter((i) => i.type !== 'turn-end').map((i) => titles.title(i))
	let early = heads()
	await new Promise((r) => setTimeout(r, 5))
	calls[0]!.push({ type: 'thinking', text: 'mm' }, { type: 'text', text: 'ok' }, { type: 'done', reason: 'end' })
	await until(() => a.of('turn-end').length)
	let saved = (await fresh(id)).items.filter((i) => i.type !== 'turn-end').map((i) => titles.title(i))
	expect(early[1]).toMatch(/^\d\d:\d\d Thinking$/)
	expect(saved.slice(0, 2)).toEqual(early)
	expect(heads()).toEqual(saved)
	expect(saved[2]).toMatch(/Hal \(fake\/m1\)$/)
	expect((await history.read(id)).filter((r) => r.type === 'assistant').map((r) => (r as { model?: string }).model)).toEqual(['fake/m1', 'fake/m1'])
})

test('a completed turn reaches every follower and is durable before turn-end', async () => {
	let a = client()
	let id = created(a)
	let b = client()
	b.conn.send({ type: 'open', sessionId: id })
	a.conn.send({ type: 'submit', sessionId: id, text: 'hi' })
	expect(await records(id)).toEqual([{ type: 'user', blocks: [{ type: 'text', text: 'hi' }] }])
	await until(() => calls.length === 1)
	calls[0]!.push({ type: 'thinking', text: 'hmm' }, { type: 'signature', value: 'sig' }, { type: 'text', text: 'hel' })
	calls[0]!.push({ type: 'text', text: 'lo' }, { type: 'usage', usage: { input: 5, output: 2 } }, { type: 'done', reason: 'end' })
	let onDisk: unknown
	let watcher = host.connect((e) => {
		if (e.type === 'turn-end') onDisk = history.readSync(id).map((r) => r.type)
	})
	watcher.send({ type: 'open', sessionId: id })
	await until(() => b.of('turn-end').length)
	expect(onDisk).toEqual(['user', 'assistant', 'assistant', 'round', 'turn_end'])

	let expected: Item[] = [
		{ type: 'prompt', text: 'hi' },
		{ type: 'thinking', text: 'hmm' },
		{ type: 'text', text: 'hello' },
		{ type: 'turn-end', status: 'completed', usage: { input: 5, output: 2 } },
	]
	expect(shown(a.views.get(id)!.items)).toEqual(expected)
	// Every client, live or fresh, keys each item alike.
	expect(b.views.get(id)!.items).toEqual(a.views.get(id)!.items)
	expect((await fresh(id)).items).toEqual(a.views.get(id)!.items)
	expect((await records(id)).at(-1)).toEqual({ type: 'turn_end', status: 'completed', reason: 'end', usage: { input: 5, output: 2 }, context: 5 })
})

test('the next turn replays durable history, even after a host restart', async () => {
	let a = client()
	let id = created(a)
	a.conn.send({ type: 'submit', sessionId: id, text: 'one' })
	await until(() => calls.length === 1)
	calls[0]!.push({ type: 'thinking', text: 'why' }, { type: 'signature', value: 'sig' }, { type: 'text', text: 'first' }, { type: 'done', reason: 'end' })
	await until(() => a.of('turn-end').length === 1)
	restartHost()

	let b = client()
	b.conn.send({ type: 'open', sessionId: id })
	await until(() => b.views.get(id))
	expect(b.views.get(id)!.items).toEqual(a.views.get(id)!.items)
	b.conn.send({ type: 'submit', sessionId: id, text: 'two' })
	await until(() => calls.length === 2)
	expect(calls[1]!.model).toBe('fake/m1')
	expect(calls[1]!.input.messages).toEqual([
		{ role: 'user', blocks: [{ type: 'text', text: stamped('one') }] },
		{
			role: 'assistant',
			blocks: [
				{ type: 'thinking', text: 'why', signature: 'sig', provider: 'fake' },
				{ type: 'text', text: 'first' },
			],
		},
		{ role: 'user', blocks: [{ type: 'text', text: stamped('two') }] },
	])
})

test('a turn cut off by a host that went away continues on the next host, told what happened', async () => {
	let a = client()
	let id = created(a)
	a.conn.send({ type: 'submit', sessionId: id, text: 'go' })
	await until(() => calls.length === 1)
	calls[0]!.push({ type: 'text', text: 'a' })
	await until(() => a.of('stream').length === 1)
	// The process dies: nothing more is written for this turn.
	history.stop(false)
	restartHost()

	// Until the new host continues it, the turn shows as running.
	let early = await fresh(id)
	expect(early.state).toEqual({ type: 'running', phase: 'requesting' })
	let b = client()
	b.conn.send({ type: 'open', sessionId: id })
	await until(() => b.views.get(id))
	await turns.recover()
	await until(() => calls.length === 2)
	expect(calls[1]!.input.messages).toEqual([
		{ role: 'user', blocks: [{ type: 'text', text: stamped('go') }] },
		{ role: 'assistant', blocks: [{ type: 'text', text: 'a' }] },
		{ role: 'user', blocks: [{ type: 'text', text: replay.continueNote }] },
	])
	calls[1]!.push({ type: 'text', text: 'b' }, { type: 'done', reason: 'end' })
	await until(() => b.of('turn-end').length)
	let expected: Item[] = [
		{ type: 'prompt', text: 'go' },
		{ type: 'text', text: 'a' },
		{ type: 'text', text: 'b' },
		{ type: 'turn-end', status: 'completed' },
	]
	expect(shown(b.views.get(id)!.items)).toEqual(expected)
	expect(b.views.get(id)!.state).toEqual({ type: 'idle' })
	expect(await fresh(id)).toEqual(b.views.get(id)!)
	// Nothing is left to continue.
	await turns.recover()
	expect(calls.length).toBe(2)
})

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
	expect(calls[1]!.input.messages.at(-1)).toEqual({ role: 'user', blocks: [{ type: 'text', text: replay.continueNote }] })
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
	expect(calls[1]!.input.messages).toEqual([{ role: 'user', blocks: [{ type: 'text', text: stamped('go') }] }])
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
		// The model picks up at the result; no note, nothing was cut off.
		expect(calls[2]!.input.messages).toEqual(calls[1]!.input.messages)
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
		let [result, note] = calls[1]!.input.messages.at(-1).blocks
		expect(result).toMatchObject({ type: 'tool_result', id: 't1', isError: true })
		expect(note).toEqual({ type: 'text', text: replay.continueNote })
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
		let [result] = calls[1]!.input.messages.at(-1).blocks
		expect(result).toMatchObject({ type: 'tool_result', id: 'b1', isError: true })
		expect(result.output).toMatch(/may or may not have run/)
		expect(ran).toBe(1)
	} finally {
		tools.run = origRun
	}
})

test('a turn that keeps bringing hosts down is paused with a reason, not continued forever', async () => {
	let a = client()
	let id = created(a)
	a.conn.send({ type: 'submit', sessionId: id, text: 'crash' })
	await until(() => calls.length === 1)
	for (let n = 1; n <= states.maxRecoveries(); n++) {
		calls.at(-1)!.push({ type: 'text', text: 'x' })
		await until(() => calls.length === n)
		restartHost()
		await turns.recover()
		await until(() => calls.length === n + 1)
	}
	restartHost()
	await turns.recover()
	expect(calls.length).toBe(states.maxRecoveries() + 1)
	let view = await fresh(id)
	expect(view.state).toMatchObject({ type: 'paused', reason: expect.stringMatching(/without progress/) })
	expect(shown(view.items)!.at(-1)).toEqual({ type: 'turn-end', status: 'paused' })
	// The user can still continue it by hand.
	let b = client()
	b.conn.send({ type: 'open', sessionId: id })
	await until(() => b.views.get(id))
	b.conn.send({ type: 'continue', sessionId: id })
	await until(() => calls.length === states.maxRecoveries() + 2)
})

test('pausing a turn another host left unfinished records it paused', async () => {
	let a = client()
	let id = created(a)
	a.conn.send({ type: 'submit', sessionId: id, text: 'go' })
	await until(() => calls.length === 1)
	restartHost()
	let b = client()
	b.conn.send({ type: 'open', sessionId: id })
	await until(() => b.views.get(id))
	b.conn.send({ type: 'pause', sessionId: id })
	await until(() => b.of('turn-end').length)
	expect(b.views.get(id)!.state).toEqual({ type: 'paused' })
	expect(await fresh(id)).toEqual(b.views.get(id)!)
	await turns.recover()
	expect(calls.length).toBe(1)
})
