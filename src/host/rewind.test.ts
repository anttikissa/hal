// Editing an earlier prompt rewinds there (task 26q): /edit <n> <text>
// drops #n on in one rebase and sends the edit (task ky7).

import { expect, test } from 'bun:test'
import { history } from './history.ts'
import { calls, client, created, shown, stamped, until, useHost } from './host-fixture.test.ts'

useHost()

const texts = (msg: any) => msg.blocks.map((b: any) => b.text)
const errors = (c: ReturnType<typeof client>) =>
	c
		.of('output')
		.filter((e) => e.error)
		.map((e) => e.text)

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
	a.conn.send({ type: 'submit', sessionId: id, text: `/edit ${n} uno`, id: 'r1' })
	let b = client()
	b.conn.send({ type: 'open', sessionId: id })
	b.conn.send({ type: 'submit', sessionId: id, text: `/edit ${n} uno`, id: 'r1' })
	await until(() => calls.length === 3 && b.of('ack').length)
	expect([...a.of('rejected'), ...b.of('rejected'), ...errors(a)]).toEqual([])
	expect(calls[2]!.input.messages.map(texts)).toEqual([[stamped('uno')]])
	calls[2]!.push({ type: 'text', text: 're uno' }, { type: 'done', reason: 'end' })
	await until(() => a.views.get(id)!.state.type === 'idle' && a.of('turn-end').length === 3)
	expect(calls).toHaveLength(3)
	expect(history.readSync(id).filter((r) => r.type === 'user' && r.amends === n)).toHaveLength(1)
	expect(shown(a.views.get(id)!.items.filter((i) => i.type === 'prompt' || i.type === 'text'))).toEqual([
		{ type: 'prompt', text: 'uno', edited: true },
		{ type: 'text', text: 're uno' },
	])
})

test('rewind refuses a running session, a non-prompt and a dropped record', async () => {
	let a = client()
	let id = created(a)
	let n = await twoTurns(a, id)
	let reply = history.readSync(id).find((r) => r.type === 'assistant')!.n!
	a.conn.send({ type: 'submit', sessionId: id, text: `/edit ${reply} x`, id: 'bad1' })
	await until(() => errors(a).length === 1)
	expect(errors(a)[0]).toContain('not a prompt')
	a.conn.send({ type: 'submit', sessionId: id, text: 'three' })
	await until(() => calls.length === 3)
	a.conn.send({ type: 'submit', sessionId: id, text: `/edit ${n} x`, id: 'bad2' })
	await until(() => errors(a).length === 2)
	expect(errors(a)[1]).toContain('running')
	calls[2]!.push({ type: 'done', reason: 'end' })
	await until(() => a.of('turn-end').length === 3)
	a.conn.send({ type: 'submit', sessionId: id, text: `/edit ${n} uno` })
	await until(() => calls.length === 4)
	calls[3]!.push({ type: 'done', reason: 'end' })
	await until(() => a.of('turn-end').length === 4)
	// A stale client still offering a dropped prompt.
	let two = history.readSync(id).find((r) => r.type === 'user' && JSON.stringify(r).includes('"two"'))!.n!
	a.conn.send({ type: 'submit', sessionId: id, text: `/edit ${two} again`, id: 'bad3' })
	await until(() => errors(a).length === 3)
	expect(errors(a)[2]).toContain('not a prompt')
	expect(history.readSync(id).filter((r) => r.type === 'user' && r.amends !== undefined)).toHaveLength(1)
})
