// The host's tabs (tabs.ts): one shared, ordered list of open sessions
// for every client, kept in state/tabs.ason.

import { expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { calls, client, restartHost, testHome, until, useHost } from './host-fixture.test.ts'
import { paths } from './paths.ts'
import { sessions } from './sessions.ts'

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

test('tabs start empty; the first tab-start creates one in cwd', () => {
	let a = client()
	let id = send(a, { type: 'tab-start', cwd: '/tmp/p' })
	let tab = ack(a, id).tab
	expect(tabsOf(a)).toEqual([expect.objectContaining({ id: tab, cwd: '/tmp/p', state: { type: 'idle' } })])
	expect(sessions.list().map((s) => s.id)).toEqual([tab])
})

test('a tab whose cwd is the Hal repo is marked hal, for its own prompt examples', () => {
	let a = client()
	let hal = newTab(a, paths.repoRoot())
	let other = newTab(a)
	expect(tabsOf(a)?.find((t) => t.id === hal)?.hal).toBe(true)
	expect(tabsOf(a)?.find((t) => t.id === other)?.hal).toBeUndefined()
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

test('closing the last tab is refused; closing a tab keeps its running turn going', async () => {
	let a = client()
	let x = newTab(a)
	expect(rejected(a, send(a, { type: 'tab-close', sessionId: x }))).toBeDefined()
	let y = newTab(a)
	a.conn.send({ type: 'open', sessionId: y })
	send(a, { type: 'submit', sessionId: y, text: 'go' })
	await until(() => calls.length === 1)
	send(a, { type: 'tab-close', sessionId: y })
	expect(ids(a)).toEqual([x])
	calls[0]!.push({ type: 'text', text: 'still here' }, { type: 'done', reason: 'end' })
	await until(() => a.of('turn-end').length)
	expect(a.views.get(y)!.items.some((i: any) => i.text === 'still here')).toBe(true)
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
	let x = newTab(a)
	a.conn.send({ type: 'open', sessionId: x })
	send(a, { type: 'submit', sessionId: x, text: 'go' })
	await until(() => calls.length === 1)
	await until(() => tabsOf(b)![0].state.type === 'running')
	expect(tabsOf(b)![0].attention).toBeUndefined()
	calls[0]!.push({ type: 'done', reason: 'end' })
	await until(() => tabsOf(b)![0].attention)
	expect(tabsOf(b)![0].state.type).toBe('idle')
	send(b, { type: 'tab-seen', sessionId: x })
	expect(tabsOf(a)![0].attention).toBeUndefined()
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
