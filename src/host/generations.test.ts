import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { ason } from '../common/ason.ts'
import { replay } from '../common/replay.ts'
import { generations } from './generations.ts'
import { history } from './history.ts'
import { host } from './host.ts'
import { liveFiles } from './live-file.ts'
import { pages } from './pages.ts'
import { paths } from './paths.ts'
import { rebasePlans } from './rebase-plans.ts'
import { rewriteHistory } from './rewrite-history.ts'
import { sessions } from './sessions.ts'

let savedHome = paths.state.home,
	home = '',
	id = ''
beforeEach(() => {
	home = mkdtempSync(`${tmpdir()}/hal-generations-`)
	paths.state.home = home
	paths.init()
	id = sessions.create({ cwd: '/', model: 'fake/m' }).id
})
afterEach(() => {
	host.reset()
	sessions.closeAll()
	paths.state.home = savedHome
	rmSync(home, { recursive: true, force: true })
})

const size = () => readFileSync(history.file(id)).length

test('a new generation takes over writing; the old file stays; numbers never repeat', () => {
	history.submit(id, 'one')
	history.submit(id, 'two')
	let first = history.file(id)
	let before = readFileSync(first, 'utf8')
	let kept = history.readSync(id).slice(0, 1)
	generations.start(id, kept, { reason: 'rebase', replaces: 'history.asonl' }, size())
	expect(history.file(id)).toEndWith('/history2.asonl')
	expect(readFileSync(first, 'utf8')).toBe(before)
	expect(history.readSync(id).map((r) => r.n)).toEqual([1])
	let three = history.submit(id, 'three')
	// #2 was dropped, never reused.
	expect(three.n).toBe(3)
	expect(history.readSync(id).map((r) => r.n)).toEqual([1, 3])
	expect(pages.marks(id).prompt).toBe(size() - readFileSync(history.file(id), 'utf8').split('\n').at(-2)!.length - 1)
	// A process without the open session (the find worker) reads the same file.
	sessions.closeAll()
	expect(history.file(id)).toEndWith('/history2.asonl')
	expect(generations.list(id)).toMatchObject([{ file: 'history2.asonl', reason: 'rebase', next: 3 }])
})

test('a switch is refused when the history grew since it was read', () => {
	history.submit(id, 'one')
	let read = size()
	history.submit(id, 'two')
	expect(() => generations.start(id, [], { reason: 'rebase' }, read)).toThrow('changed while it was rewritten')
	expect(history.file(id)).toEndWith('/history.asonl')
	expect(history.readSync(id)).toHaveLength(2)
})

test('a failed switch leaves the old generation written; the next one overwrites the orphan', () => {
	history.submit(id, 'one')
	let save = spyOn(liveFiles, 'save').mockImplementation(() => {
		throw new Error('disk full')
	})
	expect(() => generations.start(id, [], { reason: 'clear' }, size())).toThrow('disk full')
	save.mockRestore()
	expect(existsSync(`${paths.sessionDir(id)}/history2.asonl`)).toBe(true)
	expect(history.file(id)).toEndWith('/history.asonl')
	expect(sessions.open(id).generations).toBeUndefined()
	history.submit(id, 'two')
	expect(history.readSync(id)).toHaveLength(2)
	generations.start(id, history.readSync(id).slice(1), { reason: 'clear' }, size())
	expect(history.readSync(id).map((r) => r.n)).toEqual([2])
})

test('a generation file outside the session directory is refused', () => {
	sessions.closeAll()
	let path = `${paths.sessionDir(id)}/session.ason`
	let meta = ason.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
	meta.generations = [{ file: '../x/history.asonl', reason: 'rebase', next: 1, ts: '' }]
	writeFileSync(path, ason.stringify(meta))
	expect(() => history.file(id)).toThrow('invalid generations: file')
})

test('migration resolves an old rebase once, keeps the old file, and /rebase undo still reverses it', () => {
	let ts = '2026-11-09T12:00:00Z'
	let legacy = [
		{ type: 'user', blocks: [{ type: 'text', text: 'one' }], n: 1, ts },
		{ type: 'output', text: 'dropped', n: 2, ts },
		{ type: 'turn_end', status: 'completed', usage: {}, n: 3, ts },
		{ type: 'rebase', base: 3, drop: [2], edit: [], n: 4, ts },
	]
	writeFileSync(history.file(id), legacy.map((r) => ason.stringify(r, 'short') + '\n').join(''))
	let original = readFileSync(history.file(id), 'utf8')
	let current = replay.current(history.readSync(id))
	expect(rewriteHistory.migrate(id)).toBe(true)
	expect(rewriteHistory.migrate(id)).toBe(false)
	expect(generations.list(id).map((g) => `${g.file} ${g.reason}`)).toEqual(['history2.asonl migrate'])
	expect(readFileSync(`${paths.sessionDir(id)}/history.asonl`, 'utf8')).toBe(original)
	expect(replay.current(history.readSync(id))).toEqual(current)
	rebasePlans.undo(id)
	expect(replay.current(history.readSync(id)).map((r) => r.type === 'output' && r.text)).toContain('dropped')
})
