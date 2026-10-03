import { afterAll, beforeAll, expect, test } from 'bun:test'
import { transcript } from '../common/transcript.ts'
import { calls, client, created, until, useHost } from './host-fixture.test.ts'
import { history } from './history.ts'
import { tools } from './tools.ts'

useHost()

// Not offered by default (task hc); local.ts can bring it back.
let disabled = tools.disabled
beforeAll(() => (tools.disabled = []))
afterAll(() => (tools.disabled = disabled))

const ask = (input: Record<string, unknown>, id = 'q1') => ({ type: 'tool_call' as const, id, name: 'ask', input })
const question = (c: ReturnType<typeof client>, id: string) => transcript.question(c.views.get(id))

async function start(input: Record<string, unknown>) {
	let c = client()
	let id = created(c)
	c.conn.send({ type: 'submit', sessionId: id, text: 'Help decide' })
	await until(() => calls.length === 1)
	expect(calls[0]!.input.tools.some((t: any) => t.name === 'ask')).toBe(true)
	calls[0]!.push(ask(input), { type: 'done', reason: 'tool_use' })
	await until(() => question(c, id) || calls.length > 1)
	return { c, id }
}

test('a real model asks a form; an answer reaches its call as plain text', async () => {
	let { c, id } = await start({ text: 'Who will use this?', fields: [{ type: 'text', name: 'name', label: 'Name' }, { type: 'choice', name: 'role', options: ['reader', 'writer'] }, { type: 'confirm', name: 'publish' }] })
	let q = question(c, id)!
	expect(q.form.fields).toMatchObject([{ type: 'text', name: 'name' }, { type: 'choice', name: 'role' }, { type: 'choice', name: 'publish', options: ['yes', 'no'] }])
	expect(c.views.get(id)!.state).toEqual({ type: 'blocked', reason: 'question' })
	c.conn.send({ type: 'answer', sessionId: id, question: q.id, answers: { name: 'Dave', role: 'writer', publish: 'no' } })
	await until(() => calls.length === 2)
	expect(calls[1]!.input.messages.at(-1).blocks).toEqual([{ type: 'tool_result', id: 'q1', output: 'name: Dave\nrole: writer\npublish: no' }])
	calls[1]!.push({ type: 'text', text: 'Thanks, Dave.' }, { type: 'done', reason: 'end' })
	await until(() => c.of('turn-end').length)
})


test('a secret field is rejected as a tool error without showing a question', async () => {
	let { c, id } = await start({ text: 'Key?', fields: [{ type: 'secret', name: 'key' }] })
	await until(() => calls.length === 2)
	expect(question(c, id)).toBeUndefined()
	expect(calls[1]!.input.messages.at(-1).blocks).toEqual([{ type: 'tool_result', id: 'q1', output: expect.stringContaining('secret'), isError: true }])
	expect(history.readSync(id).some((r) => r.type === 'question')).toBe(false)
	calls[1]!.push({ type: 'done', reason: 'end' })
})

test('two asks in one batch park separately, then return results in call order', async () => {
	let c = client()
	let id = created(c)
	c.conn.send({ type: 'submit', sessionId: id, text: 'Plan together' })
	await until(() => calls.length === 1)
	calls[0]!.push(ask({ text: 'First name?', fields: [{ type: 'text', name: 'first' }] }, 'a'), ask({ text: 'Second name?', fields: [{ type: 'text', name: 'second' }] }, 'b'), { type: 'done', reason: 'tool_use' })
	await until(() => question(c, id))
	let first = question(c, id)!
	c.conn.send({ type: 'answer', sessionId: id, question: first.id, answers: { first: 'Ada' } })
	await until(() => question(c, id)?.id !== first.id && question(c, id))
	let second = question(c, id)!
	expect(calls.length).toBe(1)
	c.conn.send({ type: 'answer', sessionId: id, question: second.id, answers: { second: 'Grace' } })
	await until(() => calls.length === 2)
	expect(calls[1]!.input.messages.at(-1).blocks).toEqual([
		{ type: 'tool_result', id: 'a', output: 'first: Ada' },
		{ type: 'tool_result', id: 'b', output: 'second: Grace' },
	])
	calls[1]!.push({ type: 'done', reason: 'end' })
})

test('later rounds may reuse an ask call id without receiving the earlier answer', async () => {
	let { c, id } = await start({ text: 'First name?' })
	let first = question(c, id)!
	c.conn.send({ type: 'answer', sessionId: id, question: first.id, answers: { answer: 'Ada' } })
	await until(() => calls.length === 2)
	calls[1]!.push(ask({ text: 'Another name?' }), { type: 'done', reason: 'tool_use' })
	await until(() => question(c, id)?.id !== first.id && question(c, id))
	let second = question(c, id)!
	expect(calls.length).toBe(2)
	c.conn.send({ type: 'answer', sessionId: id, question: second.id, answers: { answer: 'Grace' } })
	await until(() => calls.length === 3)
	expect(calls[2]!.input.messages.at(-1).blocks[0]).toMatchObject({ output: 'answer: Grace' })
	calls[2]!.push({ type: 'done', reason: 'end' })
})
