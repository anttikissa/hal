// Queue-edit locks (task zez): the race between acquiring the lock and
// each way a queued message leaves the inbox, in both orders.
import { expect, test } from 'bun:test'
import { calls, client, created, until, useHost } from './host-fixture.test.ts'
import { status } from './status.ts'
import { turns } from './turns.ts'

useHost()

async function queued() {
	let a = client()
	let id = created(a)
	a.conn.send({ type: 'submit', sessionId: id, text: 'first' })
	await until(() => calls.length === 1)
	a.conn.send({ type: 'submit', sessionId: id, text: 'old', queue: true, id: 'queued' })
	a.conn.send({ type: 'submit', sessionId: id, text: 'later', queue: true, id: 'later' })
	return { a, id }
}

const acquire = (a: ReturnType<typeof client>, id: string, message = 'queued') => a.conn.send({ type: 'queue-edit', sessionId: id, message, edit: 'token', id: `acquire-${message}` })
const save = (a: ReturnType<typeof client>, id: string, text: string) => a.conn.send({ type: 'submit', sessionId: id, queueEdit: 'token', amend: true, edits: 'queued', text, id: 'save' })
const cancel = (a: ReturnType<typeof client>, id: string) => a.conn.send({ type: 'queue-edit-cancel', sessionId: id, edit: 'token' })
const end = (i: number) => calls[i]!.push({ type: 'done', reason: 'end' })
const lastPrompt = (i: number) => JSON.stringify(calls[i]!.input.messages.at(-1))
const waiting = (id: string) => status.inboxOf(id).map((m) => `${m.id}${m.queue ? '' : ' (steering)'}`)

test('turn end: a locked first message waits with the ones behind it; save sends it as saved', async () => {
	let { a, id } = await queued()
	acquire(a, id)
	expect(a.of('queue-edit').at(-1)).toMatchObject({ text: 'old', message: 'queued' })
	// The turn goes on: no pause, no abort.
	expect(turns.state.running.has(id)).toBe(true)
	end(0)
	await until(() => !turns.state.running.has(id))
	expect(status.stateOf(id).type).toBe('idle')
	expect(waiting(id)).toEqual(['queued', 'later'])
	// Alt-Enter while it waits queues behind, never ahead.
	a.conn.send({ type: 'submit', sessionId: id, text: 'last', queue: true, id: 'last' })
	expect(waiting(id)).toEqual(['queued', 'later', 'last'])
	save(a, id, 'edited')
	await until(() => calls.length === 2)
	expect(lastPrompt(1)).toContain('edited')
	expect(lastPrompt(1)).not.toContain('old')
	expect(waiting(id)).toEqual(['later', 'last'])
})

test('turn end wins: acquisition is refused as already delivered', async () => {
	let { a, id } = await queued()
	end(0)
	await until(() => calls.length === 2)
	acquire(a, id)
	expect(a.of('queue-edit')).toEqual([])
	expect(a.of('rejected').at(-1).reason).toContain('already delivered')
})

test('a locked later message does not hold back the first one', async () => {
	let { a, id } = await queued()
	acquire(a, id, 'later')
	end(0)
	await until(() => calls.length === 2)
	expect(lastPrompt(1)).toContain('old')
	expect(waiting(id)).toEqual(['later'])
})

test('save and cancel during the turn: the message goes at turn end, in its place', async () => {
	let { a, id } = await queued()
	acquire(a, id)
	save(a, id, 'edited')
	expect(a.of('rejected')).toEqual([])
	end(0)
	await until(() => calls.length === 2)
	expect(lastPrompt(1)).toContain('edited')
	acquire(a, id, 'later')
	end(1)
	await until(() => !turns.state.running.has(id))
	cancel(a, id)
	await until(() => calls.length === 3)
	expect(lastPrompt(2)).toContain('later')
})

test('/queue next: a locked message goes when the edit ends; once sent, acquisition is refused', async () => {
	let { a, id } = await queued()
	acquire(a, id)
	a.conn.send({ type: 'submit', sessionId: id, text: '/queue next' })
	expect(waiting(id)).toEqual(['queued', 'later'])
	cancel(a, id)
	expect(waiting(id)).toEqual(['queued (steering)', 'later'])
	a.conn.send({ type: 'submit', sessionId: id, text: '/queue next' })
	expect(waiting(id)).toEqual(['queued (steering)', 'later (steering)'])
	acquire(a, id, 'later')
	expect(a.of('rejected').at(-1).reason).toContain('already delivered')
})

test('prompt take-along: a prompt after a pause leaves a locked message queued', async () => {
	let { a, id } = await queued()
	a.conn.send({ type: 'pause', sessionId: id })
	await until(() => !turns.state.running.has(id))
	a.conn.send({ type: 'submit', sessionId: id, text: '/queue next' })
	await until(() => calls.length === 2)
	acquire(a, id)
	a.conn.send({ type: 'submit', sessionId: id, text: 'now' })
	await until(() => calls.length === 3)
	expect(lastPrompt(1)).toContain('old')
	expect(lastPrompt(2)).toContain('now')
	expect(a.of('rejected').at(-1).reason).toContain('already delivered')
	a.conn.send({ type: 'pause', sessionId: id })
	await until(() => !turns.state.running.has(id))
	acquire(a, id, 'later')
	a.conn.send({ type: 'submit', sessionId: id, text: 'again' })
	await until(() => calls.length === 4)
	expect(lastPrompt(3)).not.toContain('later')
	expect(waiting(id)).toEqual(['later'])
})

test('one window edits at a time; its disconnect releases the lock and delivery goes on', async () => {
	let { a, id } = await queued()
	let b = client()
	b.conn.send({ type: 'open', sessionId: id })
	await until(() => b.of('snapshot').length)
	acquire(a, id)
	expect(b.of('queue-hold').at(-1).message).toBe('queued')
	acquire(b, id, 'later')
	expect(b.of('rejected').at(-1).reason).toContain('Another window')
	end(0)
	await until(() => !turns.state.running.has(id))
	a.conn.close()
	await until(() => calls.length === 2)
	expect(lastPrompt(1)).toContain('old')
	expect(b.of('warning').at(-1).text).toContain('unchanged')
	expect(b.of('queue-hold').at(-1).message).toBeUndefined()
})
