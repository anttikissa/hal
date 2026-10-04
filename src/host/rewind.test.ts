// Editing an earlier prompt rewinds there (task 26q): submit with
// `rewind: n` drops #n on in one rebase and sends the edit.

import { expect, test } from 'bun:test'
import { history } from './history.ts'
import { calls, client, created, shown, stamped, until, useHost } from './host-fixture.test.ts'

useHost()

const texts = (msg: any) => msg.blocks.map((b: any) => b.text)

// Two completed turns: prompts 'one' and 'two'.
async function twoTurns(a: ReturnType<typeof client>, id: string) {
	for (let [i, text] of ['one', 'two'].entries()) {
		a.conn.send({ type: 'submit', sessionId: id, text })
		await until(() => calls.length === i + 1)
		calls[i]!.push({ type: 'text', text: `re ${text}` }, { type: 'done', reason: 'end' })
		await until(() => a.of('turn-end').length === i + 1)
	}
	return history.readSync(id).find((r) => r.type === 'user' && JSON.stringify(r).includes('"one"'))!.n!
}

test('rewind drops the prompt and everything after it, then sends the edit once', async () => {
	let a = client()
	let id = created(a)
	let n = await twoTurns(a, id)
	a.conn.send({ type: 'submit', sessionId: id, text: 'uno', rewind: n, id: 'r1' })
	let b = client()
	b.conn.send({ type: 'open', sessionId: id })
	b.conn.send({ type: 'submit', sessionId: id, text: 'uno', rewind: n, id: 'r1' })
	await until(() => calls.length === 3 && b.of('ack').length)
	expect([...a.of('rejected'), ...b.of('rejected')]).toEqual([])
	expect(calls[2]!.input.messages.map(texts)).toEqual([[stamped('uno')]])
	calls[2]!.push({ type: 'text', text: 're uno' }, { type: 'done', reason: 'end' })
	await until(() => a.views.get(id)!.state.type === 'idle' && a.of('turn-end').length === 3)
	expect(calls).toHaveLength(3)
	expect(history.readSync(id).filter((r) => r.type === 'rebase')).toHaveLength(1)
	expect(shown(a.views.get(id)!.items.filter((i) => i.type === 'prompt' || i.type === 'text'))).toEqual([
		{ type: 'prompt', text: 'uno' },
		{ type: 'text', text: 're uno' },
	])
})

test('rewind refuses a running session, a non-prompt and a dropped record', async () => {
	let a = client()
	let id = created(a)
	let n = await twoTurns(a, id)
	let reply = history.readSync(id).find((r) => r.type === 'assistant')!.n!
	a.conn.send({ type: 'submit', sessionId: id, text: 'x', rewind: reply, id: 'bad1' })
	await until(() => a.of('rejected').length === 1)
	expect(a.of('rejected')[0]!.reason).toContain('not a prompt')
	a.conn.send({ type: 'submit', sessionId: id, text: 'three' })
	await until(() => calls.length === 3)
	a.conn.send({ type: 'submit', sessionId: id, text: 'x', rewind: n, id: 'bad2' })
	await until(() => a.of('rejected').length === 2)
	expect(a.of('rejected')[1]!.reason).toContain('running')
	calls[2]!.push({ type: 'done', reason: 'end' })
	await until(() => a.of('turn-end').length === 3)
	a.conn.send({ type: 'submit', sessionId: id, text: 'uno', rewind: n })
	await until(() => calls.length === 4)
	calls[3]!.push({ type: 'done', reason: 'end' })
	await until(() => a.of('turn-end').length === 4)
	// A stale client still offering a dropped prompt.
	let two = history.readSync(id).find((r) => r.type === 'user' && JSON.stringify(r).includes('"two"'))!.n!
	a.conn.send({ type: 'submit', sessionId: id, text: 'again', rewind: two, id: 'bad3' })
	await until(() => a.of('rejected').length === 3)
	expect(a.of('rejected')[2]!.reason).toContain('not a prompt')
	expect(history.readSync(id).filter((r) => r.type === 'rebase')).toHaveLength(1)
})
