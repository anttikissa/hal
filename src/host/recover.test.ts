// Recovery on a new host (turns.recover, task zk): it costs what the open
// tabs and busy sessions cost, never what is on disk, and finds every
// unfinished turn and queued message however far back it sits.

import { expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'fs'
import { ason } from '../common/ason.ts'
import { lines } from '../common/lines.ts'
import { busy } from './busy.ts'
import { history } from './history.ts'
import { calls, client, restartHost, stamped, testHome, until, useHost } from './host-fixture.test.ts'
import { liveFiles } from './live-file.ts'
import { pages } from './pages.ts'
import { paths } from './paths.ts'
import { sessions } from './sessions.ts'
import { tabs } from './tabs.ts'
import { turns } from './turns.ts'

useHost()

const texts = (message: any) => message.blocks.map((b: any) => b.text)
const line = (r: object) => lines.encode({ ...r, ts: '2026-01-01T00:00:00Z' })

// A finished session written straight to disk, as an old host left it.
function onDisk(id: string): void {
	mkdirSync(paths.sessionDir(id), { recursive: true })
	writeFileSync(`${paths.sessionDir(id)}/session.ason`, ason.stringify({ id, cwd: '/tmp/w', model: 'fake/m1', createdAt: '2026-01-01T00:00:00Z' }))
	let records = [
		{ type: 'user', blocks: [{ type: 'text', text: 'hello' }] },
		{ type: 'assistant', block: { type: 'text', text: 'x'.repeat(2000) } },
		{ type: 'turn_end', status: 'completed', reason: 'end', usage: {} },
	]
	writeFileSync(history.file(id), records.map(line).join(''))
}

test('with 2,000 closed sessions and 100 idle tabs, recovery reads only the tabs, in under 10 ms', async () => {
	let open: string[] = []
	for (let i = 1; i <= 2100; i++) {
		let id = `${i}-abc`
		onDisk(id)
		if (i > 2000) open.push(id)
	}
	// The tabs' marks as a previous host kept them.
	for (let id of open) pages.marks(id)
	pages.reset()
	mkdirSync(paths.stateDir(), { recursive: true })
	writeFileSync(`${paths.stateDir()}/tabs.ason`, ason.stringify({ open, closed: [], attention: [] }))

	let files = new Set<string>()
	let readBytes = pages.readBytes
	let liveFile = liveFiles.liveFile
	let load = sessions.load
	pages.readBytes = (path, start, end) => (files.add(path), readBytes(path, start, end))
	liveFiles.liveFile = ((path: string, ...rest: any[]) => (files.add(path), (liveFile as any)(path, ...rest))) as typeof liveFile
	sessions.load = (id, watch) => (files.add(`${id}/session.ason`), load(id, watch))
	let best = Infinity
	let bytes = 0
	try {
		for (let run = 0; run < 3; run++) {
			restartHost()
			files.clear()
			let before = pages.state.bytesRead
			let started = performance.now()
			await turns.recover()
			best = Math.min(best, performance.now() - started)
			bytes = pages.state.bytesRead - before
		}
	} finally {
		pages.readBytes = readBytes
		liveFiles.liveFile = liveFile
		sessions.load = load
	}
	expect(calls.length).toBe(0)
	let touched = [...files].filter((f) => !f.startsWith(paths.stateDir()))
	let closedTouched = touched.filter((f) => !open.some((id) => f.includes(`/${id}/`)))
	expect(closedTouched).toEqual([])
	// Each tab: its marks and one line of its history, no metadata.
	expect(touched.length).toBeLessThanOrEqual(open.length * 2)
	expect(touched.some((f) => f.endsWith('session.ason'))).toBe(false)
	expect(bytes).toBeLessThanOrEqual(open.length * 4096)
	expect(best).toBeLessThan(10)
})

test('a queued message written 1 MB before the end of history runs after a host restart', async () => {
	let id = sessions.create({ cwd: '/tmp/w', model: 'fake/m1' }).id
	history.append(id, { type: 'user', blocks: [{ type: 'text', text: 'go' }] })
	history.append(id, { type: 'inbox', id: 'q1', text: 'later', queue: true })
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
	expect(texts(calls[0]!.input.messages.at(-1))).toEqual([stamped('later')])
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
