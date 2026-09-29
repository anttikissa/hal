// The host's tabs (tabs.ts): one shared, ordered list of open sessions
// for every client, kept in state/tabs.ason.

import { expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { calls, client, restartHost, testHome, until, useHost } from './host-fixture.test.ts'
import { paths } from './paths.ts'
import { sessions } from './sessions.ts'
import { subagents } from './subagents.ts'
import { status } from './status.ts'
import { history } from './history.ts'

useHost()

type C = ReturnType<typeof client>
let n = 0
const send = (c: C, command: any) => {
	let id = `t${++n}`
	c.conn.send({ ...command, id })
	return id
}
const tabsOf = (c: C) => c.of('tabs').at(-1)?.tabs as any[] | undefined
const ids = (c: C) => tabsOf(c)?.map((t) => t.id)
const ack = (c: C, id: string) => c.events.find((e: any) => e.type === 'ack' && e.id === id) as any
const rejected = (c: C, id: string) => c.events.find((e: any) => e.type === 'rejected' && e.id === id) as any
// Opens a new tab and returns its id, as named in the answer.
const newTab = (c: C, cwd = '/tmp/w', after?: string) => ack(c, send(c, { type: 'tab-new', cwd, ...(after ? { after } : {}) })).tab as string

test('a fresh home opens the offline intro; later tabs use the configured provider model', () => {
	let c = client()
	let first = newTab(c)
	expect(sessions.open(first).model).toBe('hal/intro')
	expect(sessions.open(newTab(c)).model).not.toBe('hal/intro')
})


test('two clients see the same order after new, move, close and resume', () => {
	let a = client()
	let b = client()
	let x = newTab(a)
	let y = newTab(b)
	let z = newTab(a, '/tmp/w', x)
	expect(ids(a)).toEqual([x, z, y])
	send(b, { type: 'tab-move', sessionId: y, index: 0 })
	expect(ids(a)).toEqual([y, x, z])
	send(a, { type: 'tab-close', sessionId: x })
	expect(ids(b)).toEqual([y, z])
	let r = send(b, { type: 'tab-resume' })
	expect(ack(b, r).tab).toBe(x)
	expect(ids(a)).toEqual([y, x, z])
	expect(ids(b)).toEqual(ids(a))
	expect(tabsOf(a)![0]).toMatchObject({ id: y, name: y, cwd: '/tmp/w' })
})

test('resume puts each closed tab back where it was, most recent first', () => {
	let a = client()
	let [p, q, r, s] = [newTab(a), newTab(a), newTab(a), newTab(a)]
	send(a, { type: 'tab-close', sessionId: q })
	send(a, { type: 'tab-close', sessionId: s })
	expect(ids(a)).toEqual([p, r])
	send(a, { type: 'tab-resume' })
	expect(ids(a)).toEqual([p, r, s])
	send(a, { type: 'tab-resume', sessionId: q })
	expect(ids(a)).toEqual([p, q, r, s])
	expect(rejected(a, send(a, { type: 'tab-resume' }))).toBeDefined()
})

test('closing a tab aborts its running turn and it cannot continue unseen', async () => {
	let a = client()
	let x = newTab(a)
	expect(rejected(a, send(a, { type: 'tab-close', sessionId: x }))).toBeDefined()
	let y = newTab(a)
	a.conn.send({ type: 'open', sessionId: y })
	send(a, { type: 'submit', sessionId: y, text: 'go' })
	await until(() => calls.length === 1)
	send(a, { type: 'tab-close', sessionId: y })
	expect(ids(a)).toEqual([x])
	await until(() => a.of('turn-end').length)
	expect(a.of('turn-end')[0].status).toBe('paused')
	calls[0]!.push({ type: 'text', text: 'should not appear' }, { type: 'done', reason: 'end' })
	await Bun.sleep(20)
	expect(a.views.get(y)!.items.some((i: any) => i.text === 'should not appear')).toBe(false)
	expect(ack(a, send(a, { type: 'tab-resume' })).tab).toBe(y)
	expect(tabsOf(a)?.find((t) => t.id === y)?.state.type).toBe('paused')
})

test('closing a parent stops owned subagent turns, but leaves an interactive child working', async () => {
	let a = client()
	newTab(a)
	let parent = newTab(a)
	sessions.open(parent).model = 'fake/m1'
	let owned = subagents.spawn(parent, { kind: 'subagent', task: 'work', fork: false, cwd: '/tmp/w', limit: 0 })
	let interactive = subagents.spawn(parent, { kind: 'interactive', task: 'independent', fork: false, cwd: '/tmp/w', limit: 0 })
	await until(() => calls.length === 2)
	send(a, { type: 'tab-close', sessionId: parent })
	await until(() => history.readSync(owned).some((r) => r.type === 'turn_end'))
	expect(history.readSync(owned).findLast((r) => r.type === 'turn_end')).toMatchObject({ status: 'paused' })
	expect(status.stateOf(interactive).type).toBe('running')
	calls[1]!.push({ type: 'done', reason: 'end' })
	await until(() => status.stateOf(interactive).type === 'idle')
})

test('a child stopped by closing an idle parent cannot restart its closed tab', async () => {
	let a = client()
	newTab(a)
	let parent = newTab(a)
	let child = subagents.spawn(parent, { kind: 'subagent', task: 'work', fork: false, cwd: '/tmp/w', model: 'fake/m1', limit: 0 })
	await until(() => calls.length === 1)
	send(a, { type: 'tab-close', sessionId: parent })
	await until(() => history.readSync(child).some((r) => r.type === 'turn_end'))
	await Bun.sleep(20)
	expect(status.stateOf(parent).type).toBe('idle')
	expect(calls.length).toBe(1)
})

test('closing a tab blocked on a question cancels it instead of restarting the turn', async () => {
	let a = client()
	newTab(a)
	let id = newTab(a)
	sessions.open(id).model = 'fake/m1'
	a.conn.send({ type: 'open', sessionId: id })
	send(a, { type: 'submit', sessionId: id, text: 'ask' })
	await until(() => calls.length === 1)
	calls[0]!.push({ type: 'tool_call', id: 'ask1', name: 'ask', input: { text: 'Why?' } }, { type: 'done', reason: 'tool_use' })
	await until(() => a.of('question').length)
	send(a, { type: 'tab-close', sessionId: id })
	expect(status.stateOf(id).type).toBe('paused')
	expect(history.readSync(id).some((r) => r.type === 'answer' && r.cancelled)).toBe(true)
	expect(history.readSync(id).at(-1)).toMatchObject({ type: 'turn_end', status: 'paused' })
	expect(calls.length).toBe(1)
})

test('tab-start prefers last if open in cwd, then the first tab in cwd, then a new one', () => {
	let a = client()
	let p1 = newTab(a, '/tmp/p')
	let q = newTab(a, '/tmp/q')
	let p2 = newTab(a, '/tmp/p')
	let start = (cwd: string, last?: string) => ack(a, send(a, { type: 'tab-start', cwd, ...(last ? { last } : {}) })).tab
	expect(start('/tmp/p', p2)).toBe(p2)
	expect(start('/tmp/p', q)).toBe(p1)
	expect(start('/tmp/p')).toBe(p1)
	send(a, { type: 'tab-close', sessionId: p2 })
	expect(start('/tmp/p', p2)).toBe(p1)
	let r = start('/tmp/r', q)
	expect([p1, q, p2]).not.toContain(r)
	expect(ids(a)).toEqual([p1, q, r])
	// Picking an existing tab changes nothing: only the starter hears.
	let other = client()
	let t = send(other, { type: 'tab-start', cwd: '/tmp/q' })
	expect(ack(other, t).tab).toBe(q)
	expect(ids(other)).toEqual([p1, q, r])
	let before = other.events.length
	start('/tmp/q')
	expect(other.events.length).toBe(before)
})

test('an unreadable session stays a tab, failed with the error, and opening it is refused with it', async () => {
	let a = client()
	newTab(a, '/tmp/p')
	let broken = newTab(a, '/tmp/p')
	writeFileSync(`${paths.sessionDir(broken)}/history.asonl`, '{ type: @@ }\n')
	send(a, { type: 'tab-new', cwd: '/tmp/p' })
	let tab = tabsOf(a)?.find((t) => t.id === broken)
	expect(tab?.state).toEqual({ type: 'error', message: expect.stringContaining(`${broken}/history.asonl: malformed history`) })
	let open = send(a, { type: 'open', sessionId: broken })
	await until(() => rejected(a, open))
	expect(rejected(a, open).reason).toContain('malformed history')
})

test('a tab wants attention when its turn ends until a client has seen it', async () => {
	let a = client()
	let b = client()
	newTab(a) // the first tab is the offline introduction, not a provider turn
	let x = newTab(a)
	a.conn.send({ type: 'open', sessionId: x })
	send(a, { type: 'submit', sessionId: x, text: 'go' })
	await until(() => calls.length === 1)
	let tab = () => tabsOf(b)!.find((t) => t.id === x)!
	await until(() => tab().state.type === 'running')
	expect(tab().attention).toBeUndefined()
	calls[0]!.push({ type: 'done', reason: 'end' })
	await until(() => tab().attention)
	expect(tab().state.type).toBe('idle')
	send(b, { type: 'tab-seen', sessionId: x })
	expect(tabsOf(a)!.find((t) => t.id === x)!.attention).toBeUndefined()
})

test('tabs, their closed positions and attention survive a host restart', () => {
	let a = client()
	let [x, y, z] = [newTab(a), newTab(a), newTab(a)]
	send(a, { type: 'tab-move', sessionId: z, index: 0 })
	send(a, { type: 'tab-close', sessionId: x })
	expect(existsSync(`${testHome()}/state/tabs.ason`)).toBe(true)
	restartHost()
	let b = client()
	expect(ack(b, send(b, { type: 'tab-start', cwd: '/tmp/w' })).tab).toBe(z)
	expect(ids(b)).toEqual([z, y])
	send(b, { type: 'tab-resume' })
	expect(ids(b)).toEqual([z, x, y])
})

test('a repeated tab command is not carried out again', () => {
	let a = client()
	newTab(a)
	a.conn.send({ type: 'tab-new', cwd: '/tmp/w', id: 'same' })
	a.conn.send({ type: 'tab-new', cwd: '/tmp/w', id: 'same' })
	expect(ids(a)!.length).toBe(2)
	expect(a.events.filter((e: any) => e.id === 'same').map((e: any) => e.tab)).toEqual([ids(a)![1], ids(a)![1]])
})

test('bad tab commands are refused', () => {
	let a = client()
	let x = newTab(a)
	expect(rejected(a, send(a, { type: 'tab-move', sessionId: x, index: 'first' }))).toBeDefined()
	expect(rejected(a, send(a, { type: 'tab-close', sessionId: 'nope' }))).toBeDefined()
	expect(rejected(a, send(a, { type: 'tab-resume', sessionId: 'nope' }))).toBeDefined()
	expect(rejected(a, send(a, { type: 'tab-new' }))).toBeDefined()
	expect(ids(a)).toEqual([x])
})

test('a malformed tabs.ason is refused and left untouched', () => {
	newTab(client())
	restartHost()
	writeFileSync(`${testHome()}/state/tabs.ason`, '{ open: [')
	let b = client()
	expect(rejected(b, send(b, { type: 'tab-start', cwd: '/tmp/w' }))).toBeDefined()
	expect(readFileSync(`${testHome()}/state/tabs.ason`, 'utf8')).toBe('{ open: [')
})

test('tab-start without a cwd (the browser) takes last if open, else the first tab, else a new one in the host cwd', () => {
	let a = client()
	let first = ack(a, send(a, { type: 'tab-start' })).tab as string
	expect(sessions.open(first).cwd).toBe(process.cwd())
	let p = newTab(a, '/tmp/p')
	expect(ack(a, send(a, { type: 'tab-start', last: p })).tab).toBe(p)
	send(a, { type: 'tab-close', sessionId: p })
	expect(ack(a, send(a, { type: 'tab-start', last: p })).tab).toBe(first)
	expect(ids(a)).toEqual([first])
})
