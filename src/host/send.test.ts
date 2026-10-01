// Messages between sessions (task rj): the send tool, who sent what,
// and how the recipient's model and clients are told.

import { expect, test } from 'bun:test'
import { amend } from '../common/amend.ts'
import { history } from './history.ts'
import { calls, client, created, fresh, readCall, shown as unkeyed, toolSession, until, useHost } from './host-fixture.test.ts'
import { sessions } from './sessions.ts'
import { tabs } from './tabs.ts'

useHost()

type C = ReturnType<typeof client>
const lastText = (n: number) => calls[n]!.input.messages.at(-1).blocks[0].text as string
const resultOf = (n: number) => calls[n]!.input.messages.at(-1).blocks.find((b: any) => b.type === 'tool_result')
const sendCall = (input: Record<string, unknown>, id = 's1') => ({ type: 'tool_call' as const, id, name: 'send', input })

// Two sessions as tabs 1 and 2; the second, the sender, named.
function pair(c: C, toolCwd = false): { a: string; b: string; by: string } {
	let a = toolCwd ? toolSession(c) : created(c)
	let b = created(c)
	tabs.insert(a, 0)
	tabs.insert(b, 1)
	sessions.open(b).name = 'helper'
	return { a, b, by: `tab 2 · ${b} · helper` }
}

// Session b's model calls send; resolves once its next round started.
async function send(c: C, b: string, input: Record<string, unknown>): Promise<number> {
	let before = calls.length
	let request = () => calls.findIndex((call, i) => i >= before && call.input.sessionId === b)
	c.conn.send({ type: 'submit', sessionId: b, text: 'tell them' })
	await until(() => request() >= 0)
	let n = request()
	calls[n]!.push(sendCall(input), { type: 'done', reason: 'tool_use' })
	let next = () => calls.findIndex((call, i) => i > n && call.input.sessionId === b)
	await until(() => next() >= 0)
	return next()
}

test('an advisory message reaches a working session with its next request, framed as not urgent, and names its sender', async () => {
	let c = client()
	let { a, b, by } = pair(c)
	c.conn.send({ type: 'submit', sessionId: a, text: 'go' })
	await until(() => calls.length === 1)
	calls[0]!.push({ type: 'text', text: 'working' })
	let next = await send(c, b, { to: '1', text: 'check the tests' })
	expect(resultOf(next)).toMatchObject({ output: `Sent to ${tabs.label(a)}` })
	expect(resultOf(next).isError).toBeUndefined()
	// Waiting, visibly from the other session.
	let waiting = c.views.get(a)!.inbox
	expect(waiting).toMatchObject([{ text: 'check the tests', from: b, label: by, advisory: true }])
	calls[0]!.push({ type: 'done', reason: 'end' })
	await until(() => calls.length === next + 2)
	let text = lastText(next + 1)
	expect(text).toMatch(new RegExp(`\\n\\[Inbox · ${by}\\]\\n<meta>[^\\n]+</meta>\\ncheck the tests$`))
	let shown = unkeyed(c.views.get(a)!.items.filter((i) => i.type === 'prompt'))
	expect(shown).toEqual([
		{ type: 'prompt', text: 'go' },
		{ type: 'prompt', text: 'check the tests', from: b, label: by, advisory: true },
	])
	calls[next + 1]!.push({ type: 'done', reason: 'end' })
	await until(() => c.views.get(a)!.state.type === 'idle')
	expect((await fresh(a)).items).toEqual(c.views.get(a)!.items)
	// Up never recalls it: the human's last message is 'go'.
	expect(amend.begin({ ...c.views.get(a)!, state: { type: 'running', phase: 'streaming' } }, '')?.editing.original).toBe('go')
})

test('an idle session gets the message as a turn of its own, with full attention', async () => {
	let c = client()
	let { a, b, by } = pair(c)
	await send(c, b, { to: a, text: 'please review' })
	await until(() => calls.length === 3)
	// The sender's next round and the recipient's own turn, in some order.
	let theirs = calls.findIndex((call) => call.input.messages.length === 1 && !lastText(calls.indexOf(call)).endsWith('tell them'))
	expect(resultOf(3 - theirs).isError).toBeUndefined()
	expect(lastText(theirs)).toMatch(new RegExp(`\\n\\[Inbox · ${by}\\]\\nplease review$`))
	expect(unkeyed(c.views.get(a)!.items)).toEqual([{ type: 'prompt', text: 'please review', from: b, label: by }])
	expect((await fresh(a)).items).toEqual(c.views.get(a)!.items)
})

test('steer is read like the user steering; queue waits for the turn to end', async () => {
	let c = client()
	let { a, b, by } = pair(c)
	c.conn.send({ type: 'submit', sessionId: a, text: 'go' })
	await until(() => calls.length === 1)
	let next = await send(c, b, { to: '1', text: 'later', queue: true })
	calls[next]!.push(sendCall({ to: '1', text: 'now', steer: true }, 's2'), { type: 'done', reason: 'tool_use' })
	let recipient = () => calls.findIndex((call, i) => i > 0 && call.input.sessionId === a && lastText(i).endsWith('now'))
	await until(() => recipient() >= 0)
	expect(c.views.get(a)!.inbox.map((m) => [m.text, m.queue, m.advisory])).toEqual([
		['later', true, undefined],
	])
	let steered = recipient()
	expect(lastText(steered)).toMatch(new RegExp(`\\n\\[Inbox · ${by}\\]\\nnow$`))
	calls[steered]!.push({ type: 'done', reason: 'end' })
	// Only after the interrupted turn completes: the queued own turn.
	let queued = () => calls.findIndex((call, i) => i > steered && call.input.sessionId === a)
	await until(() => queued() >= 0)
	expect(lastText(queued())).toMatch(new RegExp(`\\n\\[Inbox · ${by}\\]\\nlater$`))
})

test('sending to itself or to no session is an error result and delivers nothing', async () => {
	let c = client()
	let { a, b } = pair(c)
	for (let to of ['2', b, '3', '9-zzz', '../x', '']) {
		let next = await send(c, b, { to, text: 'hello' })
		expect(resultOf(next)).toMatchObject({ isError: true })
		calls[next]!.push({ type: 'done', reason: 'end' })
		await until(() => c.views.get(b)!.state.type === 'idle')
	}
	expect(history.readSync(a)).toEqual([])
})

test("a client can't claim to be another session", async () => {
	let c = client()
	let id = created(c)
	c.conn.send({ type: 'submit', sessionId: id, text: 'hi', from: '7-abc' } as any)
	await until(() => calls.length === 1)
	expect(unkeyed(c.views.get(id)!.items)).toEqual([{ type: 'prompt', text: 'hi' }])
	expect(history.readSync(id)[0]).not.toHaveProperty('blocks.0.from')
})

test("an edit of the human's delivered message leaves another session's message beside it", async () => {
	let c = client()
	let { a, b, by } = pair(c, true)
	c.conn.send({ type: 'submit', sessionId: a, text: 'look' })
	await until(() => calls.length === 1)
	calls[0]!.push(readCall())
	await until(() => c.of('stream').length)
	let next = await send(c, b, { to: '1', text: 'fyi' })
	c.conn.send({ type: 'submit', sessionId: a, text: 'and hury' })
	calls[0]!.push({ type: 'done', reason: 'tool_use' })
	await until(() => calls.length === next + 2)
	let delivered = lastText(next + 1)
	expect(delivered).toMatch(/\[Inbox · [^\n]+\]\n<meta>[^\n]+<\/meta>\nfyi\n\nand hury$/)
	// Up edits the human's text, not the later one from the other session.
	expect(amend.begin(c.views.get(a)!, '')?.editing.original).toBe('and hury')
	c.conn.send({ type: 'pause', sessionId: a })
	c.conn.send({ type: 'submit', sessionId: a, text: 'and hurry', amend: true })
	await until(() => calls.length === next + 3)
	expect(lastText(next + 2)).toBe(delivered.replace('hury', 'hurry'))
	expect(unkeyed(c.views.get(a)!.items.filter((i) => i.type === 'prompt').slice(-2))).toEqual([
		{ type: 'prompt', text: 'fyi', from: b, label: by, advisory: true },
		{ type: 'prompt', text: 'and hurry' },
	])
})

test('a paused session stays paused: the message waits for the user to continue', async () => {
	let c = client()
	let { a, b } = pair(c)
	c.conn.send({ type: 'submit', sessionId: a, text: 'go' })
	await until(() => calls.length === 1)
	c.conn.send({ type: 'pause', sessionId: a })
	await until(() => c.of('turn-end').length === 1)
	let next = await send(c, b, { to: '1', text: 'fyi' })
	expect(resultOf(next).isError).toBeUndefined()
	expect(c.views.get(a)!.state.type).toBe('paused')
	expect(c.views.get(a)!.inbox.map((m) => m.text)).toEqual(['fyi'])
	c.conn.send({ type: 'continue', sessionId: a })
	await until(() => calls.length === next + 2)
	expect(lastText(next + 1)).toMatch(/\nfyi$/)
})
