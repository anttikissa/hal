// What the user sends (prompts.ts): steering and queued messages in the
// inbox, and edits of the last prompt.

import { expect, test } from 'bun:test'
import type { StreamEvent } from '../common/blocks.ts'
import { history } from './history.ts'
import { titles } from '../common/titles.ts'
import { calls, client, created, fresh, readCall, records, restartHost, stamped, toolSession, until, useHost, shown } from './host-fixture.test.ts'
import { prompts } from './prompts.ts'
import { tools } from './tools.ts'
import { turns } from './turns.ts'

useHost()

const texts = (msg: any) => msg.blocks.map((b: any) => b.text)
const inboxOf = (c: ReturnType<typeof client>, id: string) => c.views.get(id)!.inbox.map((m) => m.text)

test('ordinary messages abort the round and coalesce before its replacement request', async () => {
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
	// Visible to everyone immediately; no provider completion is needed.
	expect(inboxOf(a, id)).toEqual(['one', 'two'])
	expect(inboxOf(b, id)).toEqual(['one', 'two'])
	expect((await fresh(id)).inbox.map((m) => m.text)).toEqual(['one', 'two'])
	expect(calls.length).toBe(1)
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
	expect(a.views.get(id)!.items.filter((i) => i.type === 'prompt').map(titles.who)).toEqual(['You', 'You (steering)', 'You (steering)'])
	// Again, and again the prefix holds.
	calls[1]!.push({ type: 'text', text: 'ok' })
	await until(() => a.views.get(id)!.items.at(-1)?.type === 'text')
	a.conn.send({ type: 'submit', sessionId: id, text: 'three' })
	await until(() => calls.length === 3)
	let second = calls[1]!.input.messages
	expect(calls[2]!.input.messages.slice(0, second.length)).toEqual(second)
	expect(texts(calls[2]!.input.messages.at(-1))).toEqual([stamped('three')])
	calls[2]!.push({ type: 'text', text: 'done' }, { type: 'done', reason: 'end' })
	await until(() => a.of('turn-end').length && b.of('turn-end').length)
	let view = await fresh(id)
	expect(shown(view.items)).toEqual([
		{ type: 'prompt', text: 'go' },
		{ type: 'text', text: 'work' },
		{ type: 'prompt', text: 'one', steering: true },
		{ type: 'prompt', text: 'two', steering: true },
		{ type: 'text', text: 'ok' },
		{ type: 'prompt', text: 'three', steering: true },
		{ type: 'text', text: 'done' },
		{ type: 'turn-end', status: 'completed' },
	])
	expect(view.items.filter((i) => i.type === 'prompt').map(titles.who)).toEqual(['You', 'You (steering)', 'You (steering)', 'You (steering)'])
	expect(a.views.get(id)).toEqual(view)
	expect(b.views.get(id)).toEqual(view)
	expect(a.of('turn-end')).toHaveLength(1)
})

test('steering before tool dispatch suppresses its call and pairs replay results', async () => {
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
		{ role: 'user', blocks: [{ type: 'tool_result', id: 't1', output: expect.stringContaining('did not run'), isError: true }] },
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
		{ id: expect.any(String), text: 'later', queue: true, ts: expect.any(String) },
		{ id: expect.any(String), text: 'now', ts: expect.any(String) },
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
	let delivered = a.views.get(id)!.items.find((i) => i.type === 'prompt' && i.text === 'later')!
	expect(delivered).toMatchObject({ queued: true })
	calls[2]!.push({ type: 'done', reason: 'end' })
	await until(() => a.of('turn-end').length === 2)
	let view = await fresh(id)
	expect(view.items.map((i) => i.type)).toEqual(['prompt', 'prompt', 'text', 'turn-end', 'prompt', 'turn-end'])
	expect(a.views.get(id)).toEqual(view)
	expect(view.items.find((i) => i.type === 'prompt' && i.text === 'later')).toMatchObject({ queued: true })
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
	expect(shown(view.items.filter((i) => i.type === 'prompt'))).toEqual([
		{ type: 'prompt', text: 'go' },
		{ type: 'prompt', text: 'first', steering: true },
		{ type: 'prompt', text: 'second' },
	])
	expect(view.items.filter((i) => i.type === 'prompt').map(titles.who)).toEqual(['You', 'You (steering)', 'You'])
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
	let pending = inboxOf(b, id).filter((text) => text === 'more').length
	let delivered = (await records(id)).filter((r) => r.type === 'user' && r.blocks.some((b) => b.type === 'text' && b.text === 'more')).length
	expect(pending + delivered).toBe(1)
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
	expect(shown(view.items.slice(3))).toEqual([
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
		expect(shown(a.views.get(id)!.items.filter((i) => i.type === 'prompt'))).toEqual([
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
	expect(shown(a.views.get(id)!.items)).toEqual([
		{ type: 'prompt', text: 'right' },
		{ type: 'text', text: 'ok' },
		{ type: 'turn-end', status: 'completed' },
	])
})

// ── Editing the last message the user sent (task dg) ──

test('an edited queued message runs as edited, in its place, and never as first written', async () => {
	let a = client()
	let id = created(a)
	a.conn.send({ type: 'submit', sessionId: id, text: 'go' })
	await until(() => calls.length === 1)
	a.conn.send({ type: 'submit', sessionId: id, text: 'tset it', queue: true, id: 'q1' })
	a.conn.send({ type: 'submit', sessionId: id, text: 'then ship', queue: true, id: 'q2' })
	a.conn.send({ type: 'submit', sessionId: id, text: 'test it', amend: true, edits: 'q1', id: 'e1' })
	expect(a.of('rejected')).toEqual([])
	expect(a.of('ack').map((e) => e.id)).toEqual(['q1', 'q2', 'e1'])
	// Edited in place, not paused: the running turn never saw it.
	expect(inboxOf(a, id)).toEqual(['test it', 'then ship'])
	expect(a.views.get(id)!.state.type).toBe('running')
	restartHost()
	expect((await fresh(id)).inbox.map((m) => [m.text, m.queue])).toEqual([['test it', true], ['then ship', true]])
	// A resend of the edit, to the next host, is not applied again.
	let b = client()
	b.conn.send({ type: 'open', sessionId: id })
	await until(() => b.views.get(id))
	b.conn.send({ type: 'submit', sessionId: id, text: 'test it', amend: true, edits: 'q1', id: 'e1' })
	expect(b.of('ack').map((e) => e.id)).toEqual(['e1'])
	expect(inboxOf(b, id)).toEqual(['test it', 'then ship'])
	await turns.recover()
	await until(() => calls.length === 2)
	calls[1]!.push({ type: 'done', reason: 'end' })
	await until(() => calls.length === 3)
	expect(texts(calls[2]!.input.messages.at(-1))).toEqual([stamped('test it')])
	calls[2]!.push({ type: 'done', reason: 'end' })
	await until(() => calls.length === 4)
	calls[3]!.push({ type: 'done', reason: 'end' })
	await until(() => b.views.get(id)!.state.type === 'idle')
	let sent = calls.flatMap((c) => c.input.messages.flatMap((m: any) => m.blocks.map((x: any) => x.text ?? '')))
	expect(sent.some((t: string) => t.includes('tset'))).toBe(false)
	expect((await fresh(id)).items.filter((i) => i.type === 'prompt').map((i: any) => i.text)).toEqual(['go', 'test it', 'then ship'])
})

test('a waiting message edited into a slash command runs as that command instead', async () => {
	let a = client()
	let id = created(a)
	a.conn.send({ type: 'submit', sessionId: id, text: 'go' })
	await until(() => calls.length === 1)
	a.conn.send({ type: 'submit', sessionId: id, text: '-help', queue: true, id: 's1' })
	a.conn.send({ type: 'submit', sessionId: id, text: '/help', amend: true, edits: 's1' })
	expect(inboxOf(a, id)).toEqual([])
	expect(a.of('command').map((e) => e.text)).toEqual(['/help'])
	expect((await fresh(id)).inbox).toEqual([])
	calls[0]!.push({ type: 'done', reason: 'end' })
	await until(() => a.views.get(id)!.state.type === 'idle')
	expect(calls).toHaveLength(1)
})

test('a message another session sent waits unedited', async () => {
	let a = client()
	let id = created(a)
	a.conn.send({ type: 'submit', sessionId: id, text: 'go' })
	await until(() => calls.length === 1)
	prompts.submit(id, 'from a peer', 'p1', false, { from: 'other' })
	a.conn.send({ type: 'submit', sessionId: id, text: 'mine now', amend: true, edits: 'p1' })
	expect(a.of('rejected')).toHaveLength(1)
	expect(a.views.get(id)!.inbox).toEqual([{ id: 'p1', text: 'from a peer', from: 'other', ts: expect.any(String) }])
})

test('an edit of a delivered steering message replaces it when only reading happened since', async () => {
	let a = client()
	let id = toolSession(a)
	a.conn.send({ type: 'submit', sessionId: id, text: 'look' })
	await until(() => calls.length === 1)
	calls[0]!.push(readCall())
	await until(() => a.of('stream').length)
	a.conn.send({ type: 'submit', sessionId: id, text: 'and hury' })
	calls[0]!.push({ type: 'done', reason: 'tool_use' })
	await until(() => calls.length === 2)
	expect(inboxOf(a, id)).toEqual([])
	// Delivered: Up now pauses and edits it as the last prompt.
	await pauseAndEdit(a, id, 'and hurry')
	await until(() => calls.length === 3)
	let msgs = calls[2]!.input.messages
	expect(msgs.slice(0, -1)).toEqual(calls[1]!.input.messages.slice(0, -1))
	expect(texts(msgs.at(-1))).toEqual([stamped('and hurry')])
	calls[2]!.push({ type: 'done', reason: 'end' })
	await until(() => a.views.get(id)!.state.type === 'idle')
	expect(await fresh(id)).toEqual(a.views.get(id)!)
	expect(a.views.get(id)!.items.filter((i) => i.type === 'prompt').map((i: any) => i.text)).toEqual(['look', 'and hurry'])
})

test('a resend of an edit still waiting for its paused turn to stop acks without a second prompt', async () => {
	let a = client()
	let id = created(a)
	a.conn.send({ type: 'submit', sessionId: id, text: 'wrnog' })
	await until(() => calls.length === 1)
	calls[0]!.push({ type: 'text', text: 'partial' })
	await until(() => a.of('stream').length)
	a.conn.send({ type: 'pause', sessionId: id })
	a.conn.send({ type: 'submit', sessionId: id, text: 'right', amend: true, id: 'a1' })
	// A reconnect resends it before the first is carried out.
	let b = client()
	b.conn.send({ type: 'open', sessionId: id })
	b.conn.send({ type: 'submit', sessionId: id, text: 'right', amend: true, id: 'a1' })
	await until(() => a.of('ack').length && b.of('ack').length)
	expect([...a.of('rejected'), ...b.of('rejected')]).toEqual([])
	await until(() => calls.length === 2)
	calls[1]!.push({ type: 'done', reason: 'end' })
	await until(() => a.views.get(id)!.state.type === 'idle')
	expect(calls).toHaveLength(2)
	expect((await records(id)).filter((r) => r.type === 'user')).toHaveLength(2)
	expect(shown(a.views.get(id)!.items.filter((i) => i.type === 'prompt'))).toEqual([{ type: 'prompt', text: 'right' }])
})
