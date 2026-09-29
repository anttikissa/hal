// Sessions spawning sessions (tasks t0, mt): the spawn and wait tools,
// the report back, slots, fork, and when a subagent's tab closes.

import { expect, test } from 'bun:test'
import type { StreamEvent } from '../common/blocks.ts'
import { history } from './history.ts'
import { calls, client, toolSession, until, useHost } from './host-fixture.test.ts'
import { sessions } from './sessions.ts'
import { status } from './status.ts'
import { tabs } from './tabs.ts'

useHost()

type C = ReturnType<typeof client>
const text = (n: number) => JSON.stringify(calls[n]!.input.messages)
const lastText = (n: number) => JSON.stringify(calls[n]!.input.messages.at(-1))
const resultOf = (n: number, id: string) => calls[n]!.input.messages.at(-1).blocks.find((b: any) => b.type === 'tool_result' && b.id === id)
const call = (id: string, name: string, input: Record<string, unknown> = {}): StreamEvent => ({ type: 'tool_call', id, name, input })
// The index of the first call whose last message mentions `s`, once
// it exists.
async function callWith(s: string, from = 0): Promise<number> {
	let find = () => calls.findIndex((_, i) => i >= from && lastText(i).includes(s))
	await until(() => find() >= 0)
	return find()
}

// A parent session as tab 1, its turn started by `prompt`.
async function parent(c: C, prompt = 'plan the work'): Promise<string> {
	let id = toolSession(c)
	tabs.insert(id, 0)
	c.conn.send({ type: 'submit', sessionId: id, text: prompt })
	await until(() => calls.length === 1)
	return id
}

test('spawn then wait in one round: the child is working, the parent sleeps until the handoff, and the child closes', async () => {
	let c = client()
	let p = await parent(c)
	calls[0]!.push(call('s1', 'spawn', { task: 'fix the bug', mode: 'fresh', name: 'fixer' }), call('w1', 'wait'), { type: 'done', reason: 'tool_use' })
	let k = await callWith('fix the bug')
	let child = tabs.file().open[1]!
	expect(sessions.open(child)).toMatchObject({ parent: p, spawn: 'subagent', name: 'fixer', slots: 0 })
	// Its first prompt comes from the parent and names it.
	let first = calls[k]!.input.messages
	expect(first).toHaveLength(1)
	expect(first[0].blocks[0].text).toContain(`[Inbox · ${tabs.label(p)}]`)
	expect(first[0].blocks[0].text).toContain(p)
	// The parent's turn ended at the wait, having seen the child.
	await until(() => status.stateOf(p).type === 'idle')
	let results = history.readSync(p).find((r) => r.type === 'user' && r.blocks.some((b) => b.type === 'tool_result'))
	expect(JSON.stringify(results)).toContain(child)
	expect(history.readSync(p).at(-1)).toMatchObject({ type: 'turn_end', status: 'completed' })
	expect(calls).toHaveLength(2)
	// Its last text, without any send, wakes the parent with a turn of
	// its own, and its tab closes.
	calls[k]!.push({ type: 'text', text: 'looking' }, call('r1', 'read', { path: 'x' }), { type: 'done', reason: 'tool_use' })
	let after = await callWith('"r1"', k + 1)
	calls[after]!.push({ type: 'text', text: 'fixed it' }, { type: 'done', reason: 'end' })
	let woke = await callWith('fixed it')
	let got = calls[woke]!.input.messages.at(-1).blocks[0].text
	expect(got).toContain(`[Inbox · tab 2 · ${child} · fixer]`)
	expect(got).not.toContain('looking')
	await until(() => !tabs.file().open.includes(child))
	expect(tabs.file().open).toEqual([p])
})

test('wait with no subagent running says so at once and the turn goes on', async () => {
	let c = client()
	let p = await parent(c)
	calls[0]!.push(call('w1', 'wait'), { type: 'done', reason: 'tool_use' })
	await until(() => calls.length === 2)
	expect(resultOf(1, 'w1').output).toMatch(/no subagent/i)
	expect(status.stateOf(p).type).toBe('running')
})

test('a wait does not end the turn while a message waits to be read', async () => {
	let c = client()
	let p = await parent(c)
	c.conn.send({ type: 'submit', sessionId: p, text: 'also check docs' })
	await until(() => status.inboxOf(p).length === 1)
	calls[0]!.push(call('s1', 'spawn', { task: 'look around', mode: 'fresh' }), call('w1', 'wait'), { type: 'done', reason: 'tool_use' })
	let next = await callWith('also check docs')
	expect(text(next)).toContain('Waiting for')
	expect(status.stateOf(p).type).toBe('running')
})

test('slots: a parent spends limit + 1 and never gets them back; too few refuse and spend nothing', async () => {
	let c = client()
	let p = await parent(c)
	calls[0]!.push(call('s1', 'spawn', { task: 'big job', mode: 'fresh', limit: 3 }), call('s2', 'spawn', { task: 'another', mode: 'fresh', limit: 1 }), { type: 'done', reason: 'tool_use' })
	let next = await callWith('"s2"', 1)
	await until(() => resultOf(next, 's2'))
	expect(resultOf(next, 's2').isError).toBe(true)
	expect(sessions.open(p).slots).toBe(1)
	let child = tabs.file().open[1]!
	expect(sessions.open(child).slots).toBe(3)
	expect(tabs.file().open).toHaveLength(2)
	let k = await callWith('big job')
	expect(calls[k]!.input.messages[0].blocks[0].text).toMatch(/at most 3 sessions/)
})

test('fork gives the child the history so far; fresh does not', async () => {
	let c = client()
	await parent(c, 'the secret word is plum')
	calls[0]!.push(call('s1', 'spawn', { task: 'forked task', mode: 'fork' }), call('s2', 'spawn', { task: 'fresh task' }), { type: 'done', reason: 'tool_use' })
	let forked = await callWith('forked task')
	let fresh = await callWith('fresh task')
	expect(text(forked)).toContain('plum')
	expect(text(fresh)).not.toContain('plum')
	// A valid conversation: the copied round's calls are answered.
	let messages = calls[forked]!.input.messages
	expect(messages.map((m: any) => m.role)).toEqual(['user', 'assistant', 'user', 'user'])
	expect(messages[2].blocks.map((b: any) => b.id)).toEqual(['s1', 's2'])
})

test('a human prompt to a subagent keeps its tab open, and its turns report nothing to the parent', async () => {
	let c = client()
	let p = await parent(c)
	calls[0]!.push(call('s1', 'spawn', { task: 'small job' }), { type: 'done', reason: 'tool_use' })
	let k = await callWith('small job')
	let child = tabs.file().open[1]!
	c.conn.send({ type: 'open', sessionId: child })
	c.conn.send({ type: 'submit', sessionId: child, text: 'and tidy up', queue: true })
	await until(() => status.inboxOf(child).length === 1)
	calls[k]!.push({ type: 'text', text: 'job done' }, { type: 'done', reason: 'end' })
	let again = await callWith('and tidy up', k + 1)
	calls[again]!.push({ type: 'text', text: 'tidied' }, { type: 'done', reason: 'end' })
	await until(() => status.stateOf(child).type === 'idle')
	expect(sessions.open(child).spawn).toBe('subagent-leave-open')
	expect(tabs.file().open).toContain(child)
	let reports = () => history.readSync(p).filter((r) => r.type === 'inbox' || r.type === 'user').map((r) => JSON.stringify(r))
	await until(() => reports().some((r) => r.includes('job done')))
	await Bun.sleep(20)
	expect(reports().some((r) => r.includes('tidied'))).toBe(false)
})

// A child whose first turn ends as `end` says; the parent sits in wait.
async function reportOf(end: (c: C, child: string, k: number) => void): Promise<string> {
	let c = client()
	await parent(c)
	calls[0]!.push(call('s1', 'spawn', { task: 'doomed job' }), call('w1', 'wait'), { type: 'done', reason: 'tool_use' })
	let k = await callWith('doomed job')
	let child = tabs.file().open[1]!
	end(c, child, k)
	let woke = await callWith(`[Inbox · ${tabs.label(child)}]`, k + 1)
	return calls[woke]!.input.messages.at(-1).blocks[0].text
}

test('a subagent that ends with no text still reports', async () => {
	expect(await reportOf((_c, _child, k) => calls[k]!.push({ type: 'done', reason: 'end' }))).toMatch(/finished without a message/)
})

test('a failed subagent reports why, so its parent never waits for nothing', async () => {
	expect(await reportOf((_c, _child, k) => calls[k]!.push({ type: 'error', message: '400 bad request', status: 400 }))).toMatch(/stopped: 400 bad request/)
})

test('a paused subagent reports it', async () => {
	expect(await reportOf((c, child) => (c.conn.send({ type: 'open', sessionId: child }), c.conn.send({ type: 'pause', sessionId: child })))).toMatch(/stopped: .*paused/)
})

test('a subagent waiting for its own reports only when its work is done', async () => {
	let c = client()
	let p = await parent(c)
	calls[0]!.push(call('s1', 'spawn', { task: 'middle job', limit: 1 }), call('w1', 'wait'), { type: 'done', reason: 'tool_use' })
	let k = await callWith('middle job')
	let mid = tabs.file().open[1]!
	calls[k]!.push({ type: 'text', text: 'delegating' }, call('s2', 'spawn', { task: 'leaf job' }), call('w2', 'wait'), { type: 'done', reason: 'tool_use' })
	let leaf = await callWith('leaf job')
	await until(() => status.stateOf(mid).type === 'idle')
	calls[leaf]!.push({ type: 'text', text: 'leaf result' }, { type: 'done', reason: 'end' })
	let back = await callWith('leaf result', leaf + 1)
	calls[back]!.push({ type: 'text', text: 'middle result' }, { type: 'done', reason: 'end' })
	let woke = await callWith('middle result', back + 1)
	expect(calls[woke]!.input.messages.at(-1).blocks[0].text).toContain(mid)
	expect(JSON.stringify(history.readSync(p))).not.toContain('delegating')
})

test('a blank interactive session opens next to its parent and does nothing', async () => {
	let c = client()
	let p = await parent(c)
	calls[0]!.push(call('s1', 'spawn', { kind: 'interactive', mode: 'fresh' }), { type: 'done', reason: 'tool_use' })
	await until(() => calls.length === 2)
	let child = tabs.file().open[1]!
	expect(sessions.open(child)).toMatchObject({ parent: p, spawn: 'interactive' })
	expect(status.stateOf(child).type).toBe('idle')
	expect(history.readSync(child)).toEqual([])
})

test('bad input is an error result and spawns nothing', async () => {
	let c = client()
	await parent(c)
	let bad = [{ kind: 'subagent' }, { task: 'x', kind: 'robot' }, { task: 'x', limit: -1 }, { task: 'x', cwd: 'no/such/dir' }, { task: 'x', model: 'nope' }]
	calls[0]!.push(...bad.map((input, i) => call(`b${i}`, 'spawn', input)), { type: 'done', reason: 'tool_use' })
	await until(() => calls.length === 2)
	for (let i = 0; i < bad.length; i++) expect(resultOf(1, `b${i}`).isError).toBe(true)
	expect(tabs.file().open).toHaveLength(1)
})
