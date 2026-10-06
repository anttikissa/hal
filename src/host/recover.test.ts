// Recovery on a new host (turns.recover, task zk): it finds every
// unfinished turn and queued message however far back it sits.

import { expect, test } from 'bun:test'
import { busy } from './busy.ts'
import { history } from './history.ts'
import { calls, client, restartHost, testHome, until, useHost } from './host-fixture.test.ts'
import { sessions } from './sessions.ts'
import { tabs } from './tabs.ts'
import { turns } from './turns.ts'

useHost()

const texts = (message: any) => message.blocks.map((b: any) => b.text)

test('a queued message written 1 MB before the end of history runs after a host restart', async () => {
	let id = sessions.create({ cwd: '/tmp/w', model: 'fake/m1' }).id
	history.append(id, { type: 'user', blocks: [{ type: 'text', text: 'go' }] })
	let queuedAt = history.append(id, { type: 'inbox', id: 'q1', text: 'later', queue: true }).ts
	// The turn goes on for a megabyte of tool rounds, then the host dies
	// after its end, before the queued prompt.
	for (let i = 0; i < 100; i++) {
		history.append(id, { type: 'assistant', block: { type: 'tool_call', id: `t${i}`, name: 'read', input: {} } })
		history.append(id, { type: 'user', blocks: [{ type: 'tool_result', id: `t${i}`, output: 'y'.repeat(10_000) }] })
	}
	history.append(id, { type: 'turn_end', status: 'completed', reason: 'end', usage: {} })
	restartHost()
	await turns.recover()
	await until(() => calls.length === 1)
	expect(texts(calls[0]!.input.messages.at(-1))).toEqual([expect.stringContaining(`<meta>Message was queued at ${queuedAt}, take that into account when reading it.</meta>\nlater`)])
	calls[0]!.push({ type: 'done', reason: 'end' })
	await until(() => !turns.state.running.has(id))
	// Nothing is left: the next host runs nothing and drops it as busy.
	restartHost()
	await turns.recover()
	expect(calls.length).toBe(1)
	expect(busy.list()).toEqual([])
})

test('a turn in a closed tab stays paused after a restart', async () => {
	let a = client()
	let tab = (id: string) => {
		a.conn.send({ type: 'tab-new', cwd: testHome(), id } as any)
		return (a.events.find((e: any) => e.type === 'ack' && e.id === id) as any).tab as string
	}
	let keep = tab('keep')
	let id = tab('work')
	sessions.open(id).model = 'fake/m1'
	a.conn.send({ type: 'open', sessionId: id })
	a.conn.send({ type: 'submit', sessionId: id, text: 'go' })
	await until(() => calls.length === 1)
	a.conn.send({ type: 'tab-close', sessionId: id, id: 'close' } as any)
	await until(() => history.readSync(id).some((r) => r.type === 'turn_end'))
	expect(tabs.file().open).toEqual([keep])
	restartHost()
	await turns.recover()
	expect(calls.length).toBe(1)
	expect(history.readSync(id).findLast((r) => r.type === 'turn_end')).toMatchObject({ status: 'paused' })
})
