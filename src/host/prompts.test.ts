// What the user sends (prompts.ts): steering and queued messages in the
// inbox, and edits of the last prompt.

import { expect, test } from 'bun:test'
import type { StreamEvent } from '../common/blocks.ts'
import { history } from './history.ts'
import { calls, client, created, fresh, readCall, records, restartHost, stamped, toolSession, until, useHost } from './host-fixture.test.ts'
import { prompts } from './prompts.ts'
import { tools } from './tools.ts'
import { turns } from './turns.ts'

useHost()

const texts = (msg: any) => msg.blocks.map((b: any) => b.text)
const inboxOf = (c: ReturnType<typeof client>, id: string) => c.views.get(id)!.inbox.map((m) => m.text)

test('a message sent while a turn runs steers it: waiting messages reach the model together, before its next request', async () => {
	let a = client()
	let id = created(a)
	let b = client()
	b.conn.send({ type: 'open', sessionId: id })
	a.conn.send({ type: 'submit', sessionId: id, text: 'go' })
	await until(() => calls.length === 1)
	calls[0]!.push({ type: 'text', text: 'work' })
	await until(() => a.of('stream').length)
	b.conn.send({ type: 'submit', sessionId: id, text: 'one' })
	a.conn.send({ type: 'submit', sessionId: id, text: 'two', id: 'x2' })
	expect([...a.of('rejected'), ...b.of('rejected')]).toEqual([])
	expect(a.of('ack').map((e) => e.id)).toEqual(['x2'])
	// Visible to everyone at once, and the round is not cut short.
	expect(inboxOf(a, id)).toEqual(['one', 'two'])
	expect(inboxOf(b, id)).toEqual(['one', 'two'])
	expect((await fresh(id)).inbox.map((m) => m.text)).toEqual(['one', 'two'])
	expect(calls.length).toBe(1)
	calls[0]!.push({ type: 'done', reason: 'end' })
	await until(() => calls.length === 2)
	expect(a.of('turn-end')).toEqual([])
	// The earlier request is a prefix of this one: the prompt cache stays warm.
	let first = calls[0]!.input.messages
	expect(calls[1]!.input.messages.slice(0, first.length)).toEqual(first)
	expect(calls[1]!.input.messages.slice(first.length)).toEqual([
		{ role: 'assistant', blocks: [{ type: 'text', text: 'work' }] },
		{ role: 'user', blocks: [{ type: 'text', text: stamped('one\n\ntwo') }] },
	])
	expect(inboxOf(a, id)).toEqual([])
	// Again, and again the prefix holds.
	a.conn.send({ type: 'submit', sessionId: id, text: 'three' })
	calls[1]!.push({ type: 'text', text: 'ok' }, { type: 'done', reason: 'end' })
	await until(() => calls.length === 3)
	let second = calls[1]!.input.messages
	expect(calls[2]!.input.messages.slice(0, second.length)).toEqual(second)
	expect(texts(calls[2]!.input.messages.at(-1))).toEqual([stamped('three')])
	calls[2]!.push({ type: 'text', text: 'done' }, { type: 'done', reason: 'end' })
	await until(() => a.of('turn-end').length && b.of('turn-end').length)
	let view = await fresh(id)
	expect(view.items).toEqual([
		{ type: 'prompt', text: 'go' },
		{ type: 'text', text: 'work' },
		{ type: 'prompt', text: 'one' },
		{ type: 'prompt', text: 'two' },
		{ type: 'text', text: 'ok' },
		{ type: 'prompt', text: 'three' },
		{ type: 'text', text: 'done' },
		{ type: 'turn-end', status: 'completed' },
	])
	expect(a.views.get(id)).toEqual(view)
	expect(b.views.get(id)).toEqual(view)
	expect(a.of('turn-end')).toHaveLength(1)
})

test('steering during a tool round follows its results', async () => {
	let a = client()
	let id = toolSession(a)
	a.conn.send({ type: 'submit', sessionId: id, text: 'look' })
	await until(() => calls.length === 1)
	calls[0]!.push(readCall())
	await until(() => a.of('stream').length)
	a.conn.send({ type: 'submit', sessionId: id, text: 'and hurry' })
	calls[0]!.push({ type: 'done', reason: 'tool_use' })
	await until(() => calls.length === 2)
	expect(calls[1]!.input.messages.slice(-2)).toEqual([
		{ role: 'user', blocks: [{ type: 'tool_result', id: 't1', output: 'remember the milk\n' }] },
		{ role: 'user', blocks: [{ type: 'text', text: stamped('and hurry') }] },
	])
	calls[1]!.push({ type: 'done', reason: 'end' })
	await until(() => a.of('turn-end').length)
	expect(await fresh(id)).toEqual(a.views.get(id)!)
})

test('a queued message waits for the turn to end, then runs as the next turn', async () => {
	let a = client()
	let id = created(a)
	a.conn.send({ type: 'submit', sessionId: id, text: 'go' })
	await until(() => calls.length === 1)
	a.conn.send({ type: 'submit', sessionId: id, text: 'later', queue: true })
	a.conn.send({ type: 'submit', sessionId: id, text: 'now' })
	expect(a.views.get(id)!.inbox).toEqual([
		{ id: expect.any(String), text: 'later', queue: true },
		{ id: expect.any(String), text: 'now' },
	])
	calls[0]!.push({ type: 'done', reason: 'end' })
	await until(() => calls.length === 2)
	expect(texts(calls[1]!.input.messages.at(-1))).toEqual([stamped('now')])
	expect(inboxOf(a, id)).toEqual(['later'])
	calls[1]!.push({ type: 'text', text: 'first done' }, { type: 'done', reason: 'end' })
	await until(() => calls.length === 3)
	expect(a.of('turn-end')).toHaveLength(1)
	expect(texts(calls[2]!.input.messages.at(-1))).toEqual([stamped('later')])
	expect(inboxOf(a, id)).toEqual([])
	calls[2]!.push({ type: 'done', reason: 'end' })
	await until(() => a.of('turn-end').length === 2)
	let view = await fresh(id)
	expect(view.items.map((i) => i.type)).toEqual(['prompt', 'prompt', 'text', 'turn-end', 'prompt', 'turn-end'])
	expect(a.views.get(id)).toEqual(view)
})

test('a queued message sent to an idle session just runs', async () => {
	let a = client()
	let id = created(a)
	a.conn.send({ type: 'submit', sessionId: id, text: 'hi', queue: true })
	await until(() => calls.length === 1)
	expect(inboxOf(a, id)).toEqual([])
})

test('the inbox survives a pause and a restart, and runs when the user continues', async () => {
	let a = client()
	let id = created(a)
	a.conn.send({ type: 'submit', sessionId: id, text: 'go' })
	await until(() => calls.length === 1)
	calls[0]!.push({ type: 'text', text: 'part' })
	await until(() => a.of('stream').length)
	a.conn.send({ type: 'submit', sessionId: id, text: 'steer' })
	a.conn.send({ type: 'submit', sessionId: id, text: 'queued', queue: true })
	a.conn.send({ type: 'pause', sessionId: id })
	await until(() => a.of('turn-end').length)
	expect(calls.length).toBe(1)
	restartHost()
	await turns.recover()
	expect(calls.length).toBe(1)
	let b = client()
	b.conn.send({ type: 'open', sessionId: id })
	await until(() => b.views.get(id))
	expect(b.views.get(id)!.state).toEqual({ type: 'paused' })
	expect(inboxOf(b, id)).toEqual(['steer', 'queued'])
	b.conn.send({ type: 'continue', sessionId: id })
	await until(() => calls.length === 2)
	expect(texts(calls[1]!.input.messages.at(-1))).toEqual([stamped('steer')])
	expect(inboxOf(b, id)).toEqual(['queued'])
	calls[1]!.push({ type: 'done', reason: 'end' })
	await until(() => calls.length === 3)
	expect(texts(calls[2]!.input.messages.at(-1))).toEqual([stamped('queued')])
	calls[2]!.push({ type: 'done', reason: 'end' })
	await until(() => b.of('turn-end').length === 2)
	expect(await fresh(id)).toEqual(b.views.get(id)!)
})

test('a queued message left behind by a host dying after a turn end runs on the next host', async () => {
	let a = client()
	let id = created(a)
	a.conn.send({ type: 'submit', sessionId: id, text: 'go' })
	await until(() => calls.length === 1)
	a.conn.send({ type: 'submit', sessionId: id, text: 'later', queue: true })
	// The host dies after writing the turn end, before the queued prompt.
	let next = prompts.next
	prompts.next = () => {}
	try {
		calls[0]!.push({ type: 'done', reason: 'end' })
		await until(() => a.of('turn-end').length)
	} finally {
		prompts.next = next
	}
	restartHost()
	await turns.recover()
	await until(() => calls.length === 2)
	expect(texts(calls[1]!.input.messages.at(-1))).toEqual([stamped('later')])
	calls[1]!.push({ type: 'done', reason: 'end' })
	let b = client()
	b.conn.send({ type: 'open', sessionId: id })
	await until(() => b.views.get(id)?.state.type === 'idle')
	expect(inboxOf(b, id)).toEqual([])
	await turns.recover()
	expect(calls.length).toBe(2)
})

test('sending to a paused turn takes the waiting messages along, oldest first', async () => {
	let a = client()
	let id = created(a)
	a.conn.send({ type: 'submit', sessionId: id, text: 'go' })
	await until(() => calls.length === 1)
	a.conn.send({ type: 'submit', sessionId: id, text: 'first' })
	a.conn.send({ type: 'pause', sessionId: id })
	await until(() => a.of('turn-end').length)
	a.conn.send({ type: 'submit', sessionId: id, text: 'second' })
	await until(() => calls.length === 2)
	expect(texts(calls[1]!.input.messages.at(-1))).toEqual([expect.stringMatching(/paused[^]*\nfirst\n\nsecond$/)])
	expect(inboxOf(a, id)).toEqual([])
	calls[1]!.push({ type: 'done', reason: 'end' })
	await until(() => a.of('turn-end').length === 2)
	let view = await fresh(id)
	expect(view.items.filter((i) => i.type === 'prompt')).toEqual([
		{ type: 'prompt', text: 'go' },
		{ type: 'prompt', text: 'first' },
		{ type: 'prompt', text: 'second' },
	])
	expect(a.views.get(id)).toEqual(view)
})

test('a steer resent to the next host is not added twice', async () => {
	let a = client()
	let id = created(a)
	a.conn.send({ type: 'submit', sessionId: id, text: 'go' })
	await until(() => calls.length === 1)
	a.conn.send({ type: 'submit', sessionId: id, text: 'more', id: 'm1' })
	a.conn.send({ type: 'submit', sessionId: id, text: 'more', id: 'm1' })
	expect(inboxOf(a, id)).toEqual(['more'])
	restartHost()
	let b = client()
	b.conn.send({ type: 'open', sessionId: id })
	await until(() => b.views.get(id))
	b.conn.send({ type: 'submit', sessionId: id, text: 'more', id: 'm1' })
	expect(b.of('ack').map((e) => e.id)).toEqual(['m1'])
	expect(inboxOf(b, id)).toEqual(['more'])
})

test('a user message to a paused turn goes on from there', async () => {
	let a = client()
	let id = created(a)
	a.conn.send({ type: 'submit', sessionId: id, text: 'go' })
	await until(() => calls.length === 1)
	a.conn.send({ type: 'pause', sessionId: id })
	await until(() => a.of('turn-end').length)
	a.conn.send({ type: 'submit', sessionId: id, text: 'actually' })
	await until(() => calls.length === 2)
	expect(a.views.get(id)!.state.type).toBe('running')
})

// ── Editing the last prompt (tasks/j1/states.md) ──

// Up while the model works: the client pauses the turn, then sends the edit.
async function pauseAndEdit(a: ReturnType<typeof client>, id: string, text: string) {
	a.conn.send({ type: 'pause', sessionId: id })
	a.conn.send({ type: 'submit', sessionId: id, text, amend: true })
}

test('an edit after only reading replaces the prompt: the model sees it as if written that way', async () => {
	let a = client()
	let id = toolSession(a)
	a.conn.send({ type: 'submit', sessionId: id, text: 'hi' })
	await until(() => calls.length === 1)
	calls[0]!.push({ type: 'text', text: 'hello' }, { type: 'done', reason: 'end' })
	await until(() => a.of('turn-end').length === 1)
	a.conn.send({ type: 'submit', sessionId: id, text: 'what did I ntoe?' })
	await until(() => calls.length === 2)
	calls[1]!.push({ type: 'text', text: 'Let me look.' }, readCall(), { type: 'done', reason: 'tool_use' })
	await until(() => calls.length === 3)
	calls[2]!.push({ type: 'text', text: 'You no' })
	await until(() => a.views.get(id)!.items.at(-1)?.type === 'text')
	await pauseAndEdit(a, id, 'what did I note?')
	await until(() => calls.length === 4)
	let expected = [...calls[1]!.input.messages.slice(0, -1), { role: 'user', blocks: [{ type: 'text', text: stamped('what did I note\\?') }] }]
	expect(calls[3]!.input.messages).toEqual(expected)
	calls[3]!.push({ type: 'text', text: 'Milk.' }, { type: 'done', reason: 'end' })
	await until(() => a.of('turn-end').length === 3)
	let view = await fresh(id)
	expect(view).toEqual(a.views.get(id)!)
	expect(view.items.slice(3)).toEqual([
		{ type: 'prompt', text: 'what did I note?' },
		{ type: 'text', text: 'Milk.' },
		{ type: 'turn-end', status: 'completed' },
	])
	// History is only appended to: the first attempt is still there.
	expect((await records(id)).some((r) => r.type === 'user' && r.blocks.some((b) => b.type === 'text' && b.text === 'what did I ntoe?'))).toBe(true)
	// And the next turn builds on the edit.
	a.conn.send({ type: 'submit', sessionId: id, text: 'thanks' })
	await until(() => calls.length === 5)
	expect(calls[4]!.input.messages.slice(0, 4)).toEqual([...expected, { role: 'assistant', blocks: [{ type: 'text', text: 'Milk.' }] }])
})

test('an edit after a tool with side effects keeps history and is sent on top', async () => {
	let origRun = tools.run
	tools.run = async (call) => ({ type: 'tool_result', id: call.id, output: '[exit 0]\n' })
	try {
		let a = client()
		let id = created(a)
		a.conn.send({ type: 'submit', sessionId: id, text: 'clean up' })
		await until(() => calls.length === 1)
		let rm: StreamEvent = { type: 'tool_call', id: 'b1', name: 'bash', input: { command: 'rm x', description: 'Delete x' } }
		calls[0]!.push(rm, { type: 'done', reason: 'tool_use' })
		await until(() => calls.length === 2)
		await pauseAndEdit(a, id, 'clean up, but keep x')
		await until(() => calls.length === 3)
		let msgs = calls[2]!.input.messages
		expect(msgs.slice(0, -1)).toEqual(calls[1]!.input.messages)
		expect(msgs.at(-1).blocks[0].text).toMatch(/paused the previous turn[^]*\nclean up, but keep x$/)
		calls[2]!.push({ type: 'done', reason: 'end' })
		await until(() => a.of('turn-end').length === 2)
		expect(await fresh(id)).toEqual(a.views.get(id)!)
		expect(a.views.get(id)!.items.filter((i) => i.type === 'prompt')).toEqual([
			{ type: 'prompt', text: 'clean up' },
			{ type: 'prompt', text: 'clean up, but keep x' },
		])
	} finally {
		tools.run = origRun
	}
})

test('an edit sent while the paused turn is still stopping waits for it to end', async () => {
	let a = client()
	let id = created(a)
	a.conn.send({ type: 'submit', sessionId: id, text: 'wrnog' })
	await until(() => calls.length === 1)
	calls[0]!.push({ type: 'text', text: 'partial' })
	await until(() => a.of('stream').length)
	// Both arrive before the aborted stream has wound down.
	await pauseAndEdit(a, id, 'right')
	await until(() => calls.length === 2)
	expect(calls[1]!.input.messages).toEqual([{ role: 'user', blocks: [{ type: 'text', text: stamped('right') }] }])
	calls[1]!.push({ type: 'text', text: 'ok' }, { type: 'done', reason: 'end' })
	await until(() => history.readSync(id).at(-1)?.type === 'turn_end')
	expect((await records(id)).map((r) => r.type)).toEqual(['user', 'assistant', 'turn_end', 'user', 'assistant', 'turn_end'])
	expect(await fresh(id)).toEqual(a.views.get(id)!)
	expect(a.views.get(id)!.items).toEqual([
		{ type: 'prompt', text: 'right' },
		{ type: 'text', text: 'ok' },
		{ type: 'turn-end', status: 'completed' },
	])
})
