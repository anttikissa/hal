import { expect, test } from 'bun:test'
import { calls, client, created, restartHost, until, useHost } from './host-fixture.test.ts'
import { history } from './history.ts'
import { prompts } from './prompts.ts'
import { queueEdits } from './queue-edits.ts'
import { status } from './status.ts'
import { slash } from './slash.ts'
import { tools } from './tools.ts'
import { turns } from './turns.ts'

useHost()

async function queued(running = true) {
	let a = client()
	let id = created(a)
	let count = calls.length
	a.conn.send({ type: 'submit', sessionId: id, text: 'first' })
	await until(() => calls.length === count + 1)
	a.conn.send({ type: 'submit', sessionId: id, text: 'old', queue: true, id: 'queued' })
	a.conn.send({ type: 'submit', sessionId: id, text: 'later', queue: true, id: 'later' })
	if (!running) {
		a.conn.send({ type: 'pause', sessionId: id })
		await until(() => !turns.state.running.has(id))
	}
	return { a, id }
}

function acquire(a: ReturnType<typeof client>, id: string, edit = 'token') {
	a.conn.send({ type: 'queue-edit', sessionId: id, message: 'queued', edit, id: 'acquire' })
}

test('acquisition wins the delivery race and other connections cannot bypass it', async () => {
	let { a, id } = await queued()
	let b = client()
	b.conn.send({ type: 'open', sessionId: id })
	await until(() => b.of('snapshot').length)
	acquire(a, id)
	expect(a.of('queue-edit').at(-1)).toMatchObject({ text: 'old', message: 'queued' })
	expect(b.of('queue-edit')).toEqual([])
	for (let text of ['/queue next', '/queue clear', '/clear', '/rebase']) b.conn.send({ type: 'submit', sessionId: id, text })
	b.conn.send({ type: 'continue', sessionId: id })
	b.conn.send({ type: 'rebase-apply', sessionId: id, base: 0, todo: '' })
	expect(b.of('rejected')).toHaveLength(6)
	expect(prompts.resume(id)).toContain('being edited')
	expect(slash.command(id, '/clear', { name: 'clear', args: '' }, undefined, undefined, undefined, 'model')).toContain('being edited')
	prompts.next(id)
	await until(() => !turns.state.running.has(id))
	expect(calls).toHaveLength(1)
	expect(status.inboxOf(id).map((m) => m.id)).toEqual(['queued', 'later'])
	let c = client()
	c.conn.send({ type: 'open', sessionId: id })
	await until(() => c.of('snapshot').length)
	expect(c.of('snapshot')[0].snapshot.queueHold).toBe('queued')
})

test('delivery wins the race: acquisition visibly refuses instead of recalling a delivered prompt', async () => {
	let { a, id } = await queued(false)
	prompts.next(id)
	acquire(a, id)
	expect(a.of('queue-edit')).toEqual([])
	expect(a.of('rejected').at(-1).reason).toContain('no longer queued')
})

test('save keeps timestamp/order, records dedup, and does not clear the ordinary draft', async () => {
	let { a, id } = await queued(false)
	let original = status.inboxOf(id)[0]!
	a.conn.send({ type: 'draft', sessionId: id, text: 'draft' })
	acquire(a, id)
	a.conn.send({ type: 'submit', sessionId: id, queueEdit: 'token', amend: true, edits: 'queued', text: '/queue clear', id: 'slash-save' })
	expect(a.of('rejected')).toEqual([])
	expect(status.inboxOf(id)[0]?.text).toBe('/queue clear')
	expect(history.readSync(id).some((r) => r.type === 'command')).toBe(false)
	acquire(a, id)
	let save = { type: 'submit', sessionId: id, queueEdit: 'token', amend: true, edits: 'queued', text: 'edited', id: 'save' }
	a.conn.send(save)
	expect(status.inboxOf(id)).toEqual([{ ...original, text: 'edited' }, expect.objectContaining({ id: 'later' })])
	expect(status.stateOf(id).type).toBe('paused')
	expect(a.of('draft').at(-1).draft.text).toBe('draft')
	a.conn.send(save)
	expect(history.readSync(id).filter((r) => r.type === 'inbox' && r.command === 'save')).toHaveLength(1)
	restartHost()
	let b = client()
	b.conn.send({ type: 'open', sessionId: id })
	await until(() => b.of('snapshot').length)
	acquire(b, id)
	b.conn.send(save)
	expect(b.of('queue-hold').at(-1).message).toBeUndefined()
	expect(b.of('rejected')).toEqual([])
	expect(history.readSync(id).filter((r) => r.type === 'inbox' && r.command === 'save')).toHaveLength(1)
})

test('cancel resumes only the running turn that acquisition paused', async () => {
	let { a, id } = await queued()
	acquire(a, id)
	a.conn.send({ type: 'queue-edit-cancel', sessionId: id, edit: 'token' })
	await until(() => calls.length === 2)
	expect(status.inboxOf(id)[0]?.text).toBe('old')
	a.conn.send({ type: 'pause', sessionId: id })
	await until(() => !turns.state.running.has(id))
	acquire(a, id)
	a.conn.send({ type: 'queue-edit-cancel', sessionId: id, edit: 'token' })
	expect(status.stateOf(id).type).toBe('paused')
	expect(calls).toHaveLength(2)
})

test('disconnect leaves a durable pause, reacquisition is fresh, and a stolen token owns nothing', async () => {
	let { a, id } = await queued()
	acquire(a, id)
	let b = client()
	b.conn.send({ type: 'open', sessionId: id })
	await until(() => b.of('snapshot').length)
	acquire(b, id)
	b.conn.send({ type: 'queue-edit-cancel', sessionId: id, edit: 'token' })
	expect(b.of('rejected')).toHaveLength(2)
	a.conn.close()
	await until(() => !turns.state.running.has(id))
	expect(b.of('warning').at(-1).text).toContain('stays paused')
	acquire(b, id)
	expect(b.of('queue-edit')).toHaveLength(1)
	b.conn.send({ type: 'queue-edit-cancel', sessionId: id, edit: 'token' })
	expect(calls).toHaveLength(1)
	restartHost()
	let c = client()
	c.conn.send({ type: 'open', sessionId: id })
	await until(() => c.of('snapshot').length)
	expect(c.of('snapshot')[0].snapshot.state.type).toBe('paused')
	expect(c.of('snapshot')[0].snapshot.queueHold).toBeUndefined()
})

test('an explicit pause after acquisition suppresses automatic resume', async () => {
	let { a, id } = await queued()
	acquire(a, id)
	a.conn.send({ type: 'pause', sessionId: id })
	a.conn.send({ type: 'queue-edit-cancel', sessionId: id, edit: 'token' })
	await until(() => !turns.state.running.has(id))
	expect(calls).toHaveLength(1)
	expect(status.stateOf(id).type).toBe('paused')
})

for (let disconnect of [false, true]) test(`${disconnect ? 'disconnect' : 'pause'} while cancellation settles prevents delayed automatic resume`, async () => {
	let { a, id } = await queued()
	let count = calls.length
	acquire(a, id)
	a.conn.send({ type: 'queue-edit-cancel', sessionId: id, edit: 'token' })
	if (disconnect) a.conn.close()
	else a.conn.send({ type: 'pause', sessionId: id })
	await until(() => !turns.state.running.has(id))
	expect(calls).toHaveLength(count)
	expect(status.stateOf(id).type).toBe('paused')
})

test('the acquisition pause survives takeover before the canceled turn settles', async () => {
	let { a, id } = await queued()
	calls[0]!.push({ type: 'text', text: 'unfinished block' })
	await until(() => a.of('stream').length)
	acquire(a, id)
	expect(turns.state.running.has(id)).toBe(true)
	restartHost()
	await turns.recover()
	let b = client()
	b.conn.send({ type: 'open', sessionId: id })
	await until(() => b.of('snapshot').length)
	expect(b.of('snapshot')[0].snapshot.state.type).toBe('paused')
	expect(status.inboxOf(id)[0]?.id).toBe('queued')
	expect(b.of('snapshot')[0].snapshot.queueHold).toBeUndefined()
	acquire(b, id)
	expect(b.of('queue-edit')).toHaveLength(1)
	expect(calls).toHaveLength(1)
	b.conn.send({ type: 'queue-edit-cancel', sessionId: id, edit: 'token' })
	b.conn.send({ type: 'continue', sessionId: id })
	await until(() => calls.length === 2)
})

test('takeover during a settling tool honors the durable pause before recovery', async () => {
	let original = tools.run
	let finish = () => {}
	let entered = false
	let waiting = new Promise<void>((resolve) => { finish = resolve })
	tools.run = async (call) => {
		entered = true
		await waiting
		return { type: 'tool_result', id: call.id, output: 'finished' }
	}
	try {
		let { a, id } = await queued()
		calls[0]!.push({ type: 'tool_call', id: 'read1', name: 'read', input: { path: '/tmp/example' } }, { type: 'done', reason: 'tool_use' })
		await until(() => entered)
		acquire(a, id)
		expect(turns.state.running.has(id)).toBe(true)
		restartHost()
		finish()
		await turns.recover()
		expect(status.stateOf(id).type).toBe('paused')
		expect(status.inboxOf(id).map((m) => m.id)).toEqual(['queued', 'later'])
		expect(calls).toHaveLength(1)
	} finally {
		finish()
		tools.run = original
	}
})


test('an explicit fresh queue turn clears edit-pause intent before takeover', async () => {
	let { a, id } = await queued(false)
	acquire(a, id)
	a.conn.send({ type: 'queue-edit-cancel', sessionId: id, edit: 'token' })
	expect(queueEdits.paused(id)).toBe(true)
	a.conn.send({ type: 'submit', sessionId: id, text: '/queue next' })
	await until(() => calls.length === 2)
	expect(queueEdits.paused(id)).toBe(false)
	restartHost()
	await turns.recover()
	await until(() => calls.length === 3)
	expect(status.stateOf(id).type).toBe('running')
})
