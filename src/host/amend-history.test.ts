// Repeated prompt edits touch only their tail, and restart preserves their meaning.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { lines } from '../common/lines.ts'
import { replay, type HistoryRecord } from '../common/replay.ts'
import { amendHistory } from './amend-history.ts'
import { history } from './history.ts'
import { historyTail } from './history-tail.ts'
import { host } from './host.ts'
import { pages } from './pages.ts'
import { paths } from './paths.ts'
import { sessions } from './sessions.ts'
import { snapshots } from './snapshots.ts'

let saved = paths.state.home,
	home = '',
	id = ''
beforeEach(() => {
	home = mkdtempSync(`${tmpdir()}/hal-tail-`)
	paths.state.home = home
	paths.init()
	id = sessions.create({ cwd: '/', model: 'fake/m' }).id
})
afterEach(() => {
	host.reset()
	sessions.closeAll()
	paths.state.home = saved
	rmSync(home, { recursive: true, force: true })
})

test('a hundred amendments leave the large prefix untouched and never replay it', () => {
	let records: HistoryRecord[] = Array.from({ length: 5000 }, (_, i) => ({
		type: 'output',
		text: 'x'.repeat(2000),
		n: i + 1,
		ts: '2026-11-09T12:00:00Z',
	}))
	let prefix = Buffer.from(records.map((r) => lines.encode(r)).join(''))
	writeFileSync(history.file(id), prefix)
	history.submit(id, 'original')
	history.append(id, { type: 'turn_end', status: 'paused', usage: {} })
	let read = pages.state.bytesRead
	for (let i = 0; i < 100; i++) {
		let tail = historyTail.read(id)
		let old = tail.records.find((r) => r.type === 'user' && r.inactive === undefined)!
		amendHistory.apply(id, tail, { type: 'user', blocks: [{ type: 'text', text: `edit ${i}` }], amends: old.n })
	}
	expect(pages.state.bytesRead - read).toBeLessThan(2_000_000)
	expect(readFileSync(history.file(id)).subarray(0, prefix.length)).toEqual(prefix)
	expect(pages.marks(id).rebase).toBeUndefined()
	let current = replay.current(history.readSync(id))
	expect(current.filter((r) => r.type === 'user')).toHaveLength(1)
	expect(current.at(-1)).toMatchObject({ blocks: [{ text: 'edit 99' }] })
	sessions.closeAll()
	pages.reset()
	history.state.cache.clear()
	let restart = pages.state.bytesRead
	expect(snapshots.build(id).history.at(-1)).toMatchObject({ blocks: [{ text: 'edit 99' }] })
	expect(pages.state.bytesRead - restart).toBeLessThan(400_000)
	amendHistory.undo(id)
	expect(replay.current(history.readSync(id)).filter((r) => r.type === 'user')).toMatchObject([
		{ blocks: [{ text: 'edit 98' }] },
	])
	let before = snapshots.build(id)
	let inactive = JSON.parse(JSON.stringify(pages.marks(id).inactive))
	pages.reset()
	rmSync(`${paths.sessionDir(id)}/marks.ason`)
	expect(pages.marks(id).inactive).toEqual(inactive)
	expect(snapshots.build(id)).toEqual(before)
})
