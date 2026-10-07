// Messages between sessions (task rj): the send tool, who sent what,
// and how the recipient's model and clients are told.

import { expect, test } from 'bun:test'
import { amend } from '../common/amend.ts'
import { history } from './history.ts'
import { calls, client, created, fresh, heard, readCall, shown as unkeyed, toolSession, until, useHost } from './host-fixture.test.ts'
import { sessions } from './sessions.ts'
import { tabs } from './tabs.ts'

useHost()

type C = ReturnType<typeof client>
const lastText = (n: number) => calls[n]!.input.messages.at(-1).blocks[0].text as string
const resultOf = (n: number) => calls[n]!.input.messages.at(-1).blocks.find((b: any) => b.type === 'tool_result')
const sendCall = (input: Record<string, unknown>, id = 's1') => ({ type: 'tool_call' as const, id, name: 'send', input: { description: 'Ask for checks', ...input } })

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
	expect(resultOf(next)).toMatchObject({ output: `Sent to ${tabs.label(a)}: it reads this before its next request` })
	expect(resultOf(next).isError).toBeUndefined()
	// Waiting, visibly from the other session.
	let waiting = c.views.get(a)!.inbox
	expect(waiting).toMatchObject([{ text: 'check the tests', from: b, label: by, advisory: true, summary: 'Ask for checks' }])
	calls[0]!.push({ type: 'done', reason: 'end' })
	await until(() => calls.length === next + 2)
	let text = lastText(next + 1)
	expect(text).toMatch(new RegExp(`^\\[[^\\]\\n]*message from ${heard(by).replace(/[()]/g, '\\$&')}[^\\]\\n]*\\]\\n<meta>[^\\n]+</meta>\\ncheck the tests$`))
	let shown = unkeyed(c.views.get(a)!.items.filter((i) => i.type === 'prompt'))
	expect(shown).toEqual([
		{ type: 'prompt', text: 'go' },
		{ type: 'prompt', text: 'check the tests', from: b, label: by, advisory: true, summary: 'Ask for checks' },
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
	expect(lastText(theirs)).toMatch(new RegExp(`^\\[[^\\]\\n]*message from ${heard(by).replace(/[()]/g, '\\$&')}[^\\]\\n]*\\]\\nplease review$`))
	expect(unkeyed(c.views.get(a)!.items)).toEqual([{ type: 'prompt', text: 'please review', from: b, label: by, summary: 'Ask for checks' }])
	expect((await fresh(a)).items).toEqual(c.views.get(a)!.items)
})

test('emergency is read like the user steering; queue waits for the turn to end', async () => {
	let c = client()
	let { a, b, by } = pair(c)
	c.conn.send({ type: 'submit', sessionId: a, text: 'go' })
	await until(() => calls.length === 1)
	let next = await send(c, b, { to: '1', text: 'later', delivery: 'queue' })
	calls[next]!.push(sendCall({ to: '1', text: 'now', delivery: 'emergency' }, 's2'), { type: 'done', reason: 'tool_use' })
	let recipient = () => calls.findIndex((call, i) => i > 0 && call.input.sessionId === a && lastText(i).endsWith('now'))
	await until(() => recipient() >= 0)
	expect(c.views.get(a)!.inbox.map((m) => [m.text, m.queue, m.advisory])).toEqual([
		['later', true, undefined],
	])
	let queuedAt = c.views.get(a)!.inbox[0]!.ts!
	let steered = recipient()
	expect(lastText(steered)).toMatch(new RegExp(`^\\[[^\\]\\n]*message from ${heard(by).replace(/[()]/g, '\\$&')}[^\\]\\n]*\\]\\nnow$`))
	calls[steered]!.push({ type: 'done', reason: 'end' })
	// Only after the interrupted turn completes: the queued own turn.
	let queued = () => calls.findIndex((call, i) => i > steered && call.input.sessionId === a)
	await until(() => queued() >= 0)
	expect(lastText(queued())).toMatch(`message from ${heard(by)}`)
	expect(lastText(queued())).toContain(`]\n<meta>Message was queued at ${queuedAt}, take that into account when reading it.</meta>\nlater`)
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
	expect(delivered).toMatch(/\[[^\]\n]*message from [^\n]+\]\n<meta>[^\n]+<\/meta>\nfyi\n\n\[[^\]\n]*\]\nand hury$/)
	// Up edits the human's text, not the later one from the other session.
	expect(amend.begin(c.views.get(a)!, '')?.editing.original).toBe('and hury')
	c.conn.send({ type: 'pause', sessionId: a })
	c.conn.send({ type: 'submit', sessionId: a, text: 'and hurry', amend: true })
	await until(() => calls.length === next + 3)
	// The edit is a new record, so its block ids differ (task c2t).
	let body = (t: string) => t.replace(/^\[[^\]\n]*\]$/gm, '[]')
	expect(body(lastText(next + 2))).toBe(body(delivered.replace('hury', 'hurry')))
	expect(unkeyed(c.views.get(a)!.items.filter((i) => i.type === 'prompt').slice(-2))).toEqual([
		{ type: 'prompt', text: 'fyi', from: b, label: by, advisory: true, summary: 'Ask for checks' },
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
	expect(resultOf(next)).toMatchObject({ output: `Waiting in ${tabs.label(a)}: it is paused; it reads this when the user continues it` })
	expect(c.views.get(a)!.state.type).toBe('paused')
	expect(c.views.get(a)!.inbox.map((m) => m.text)).toEqual(['fyi'])
	c.conn.send({ type: 'continue', sessionId: a })
	await until(() => calls.length === next + 2)
	expect(lastText(next + 1)).toMatch(/\nfyi$/)
})

test.each(['pause', 'failure', 'question'])('an emergency resumes a recipient after %s instead of waiting for a human', async (stop) => {
	let c = client()
	let { a, b } = pair(c)
	c.conn.send({ type: 'submit', sessionId: a, text: 'go' })
	await until(() => calls.length === 1)
	if (stop === 'pause') c.conn.send({ type: 'pause', sessionId: a })
	else if (stop === 'failure') calls[0]!.push({ type: 'error', message: '400 bad request', status: 400 })
	else calls[0]!.push({ type: 'text', text: '<question>Continue?</question>' }, { type: 'done', reason: 'end' })
	await until(() => c.of('turn-end').length === 1)
	let next = await send(c, b, { to: '1', text: 'STOP', delivery: 'emergency' })
	let recipient = () => calls.findIndex((call, i) => i > 0 && call.input.sessionId === a)
	await until(() => recipient() >= 0)
	expect(resultOf(next).output).toContain('it started a turn')
	expect(lastText(recipient())).toMatch(/\nSTOP$/)
	expect(c.views.get(a)!.inbox).toEqual([])
})

// The old-flag error is temporary (task zb0): this fails after the
// deadline until the LEGACY-SEND check in tools/send.ts and this test are gone.
test('the legacy send flags steer and queue are rejected until 2026-10-10', async () => {
	let c = client()
	let { b } = pair(c)
	let next = await send(c, b, { to: '1', text: 'x', steer: true })
	expect(resultOf(next)).toMatchObject({ isError: true, output: expect.stringContaining("delivery 'emergency'") })
	expect(Date.now(), 'delete the LEGACY-SEND check in tools/send.ts and this test').toBeLessThan(Date.parse('2026-10-10T00:00:00Z'))
})
