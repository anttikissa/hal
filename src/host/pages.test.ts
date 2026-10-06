import { afterEach, beforeEach, expect, test } from 'bun:test'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { ason } from '../common/ason.ts'
import { lines } from '../common/lines.ts'
import { forms } from '../common/forms.ts'
import { inbox } from '../common/inbox.ts'
import type { HistoryRecord } from '../common/replay.ts'
import { states } from '../common/states.ts'
import { history } from './history.ts'
import { host } from './host.ts'
import { liveFiles } from './live-file.ts'
import { marksWorker } from './marks-worker.ts'
import { paths } from './paths.ts'
import { pages } from './pages.ts'
import { sessions } from './sessions.ts'

const savedHome = process.env.HAL_HOME
const origOnError = liveFiles.onError
let home = ''

beforeEach(() => {
	home = mkdtempSync(`${tmpdir()}/hal-pages-`)
	process.env.HAL_HOME = home
	liveFiles.onError = () => {}
})

afterEach(() => {
	host.reset()
	sessions.closeAll()
	liveFiles.onError = origOnError
	if (savedHome === undefined) delete process.env.HAL_HOME
	else process.env.HAL_HOME = savedHome
	rmSync(home, { recursive: true, force: true })
})

const newSession = () => sessions.create({ cwd: '/', model: 'fake/m' }).id
const text = (n: number) => 'x'.repeat(n)

// One completed turn: a prompt, a reply of `size` characters, an end.
function turn(id: string, n: number, size = 1000) {
	history.submit(id, `prompt ${n}`)
	history.append(id, { type: 'assistant', block: { type: 'text', text: `reply ${n} ${text(size)}` } })
	history.append(id, { type: 'turn_end', status: 'completed', usage: { input: n } })
}

// Counts the history bytes read from disk while `fn` runs.
function counted<T>(fn: () => T): { value: T; bytes: number } {
	let before = pages.state.bytesRead
	let value = fn()
	return { value, bytes: pages.state.bytesRead - before }
}

test('a snapshot of a 20 MB history reads at most the budget and keeps an open question from far back', () => {
	let id = newSession()
	turn(id, 0)
	history.submit(id, 'the last prompt')
	history.append(id, { type: 'question', id: 'q1', form: { text: 'Allow?', fields: [{ type: 'choice', name: 'ok', options: ['yes', 'no'] }] }, usage: { input: 3 } })
	history.append(id, { type: 'inbox', id: 'i1', text: 'waiting since long ago' })
	// While it waits, slash commands say a lot.
	for (let i = 0; i < 400; i++) history.append(id, { type: 'output', text: `out ${i} ${text(50_000)}` })
	history.append(id, { type: 'output', text: 'the very last output' })
	expect(statSync(history.file(id)).size).toBeGreaterThan(20_000_000)
	sessions.closeAll()
	pages.reset()
	let { value: snap, bytes } = counted(() => pages.snapshot(id))
	expect(bytes).toBeLessThanOrEqual(pages.budget)
	let all = [...snap.earlier, ...snap.history]
	expect(snap.history.at(-1)).toMatchObject({ type: 'output', text: 'the very last output' })
	expect(forms.open(all)?.id).toBe('q1')
	expect(inbox.pending(all).map((i) => i.id)).toEqual(['i1'])
	expect(states.fromHistory(all)).toEqual({ type: 'blocked', reason: 'question' })
	expect(snap.older).toBeGreaterThan(0)
})

test('a snapshot tail starts at a prompt: it never cuts a turn in two', () => {
	let id = newSession()
	for (let i = 0; i < 100; i++) turn(id, i, 10_000)
	let snap = pages.snapshot(id, 50_000)
	expect(snap.history[0]).toMatchObject({ type: 'user', blocks: [{ type: 'text', text: expect.stringMatching(/^prompt /) }] })
	expect(snap.history.at(-1)?.type).toBe('turn_end')
	expect(snap.earlier.every((r) => snap.history.indexOf(r) < 0)).toBe(true)
})

test('paging back from the snapshot yields every record exactly once and in order', () => {
	let id = newSession()
	for (let i = 0; i < 60; i++) turn(id, i, 3000 + ((i * 7919) % 5000))
	history.append(id, { type: 'output', text: text(40_000) })
	let full = history.readSync(id)
	let snap = pages.snapshot(id, 20_000)
	let got = snap.history
	let before = snap.older
	let n = 0
	while (before !== undefined) {
		let page = pages.page(id, before, 20_000)
		expect(page.records.length).toBeGreaterThan(0)
		got = [...page.records, ...got]
		before = page.start > 0 ? page.start : undefined
		n++
	}
	expect(n).toBeGreaterThan(3)
	expect(got).toEqual(full)
})

test('a page asked from a spot that is not a record boundary is refused', () => {
	let id = newSession()
	turn(id, 0)
	expect(() => pages.page(id, 5)).toThrow(/boundary/)
	expect(() => pages.page(id, statSync(history.file(id)).size + 10)).toThrow(/boundary/)
})

test('what the state needs from earlier stays right as history grows and without a marks file', () => {
	let id = newSession()
	let full = () => history.readSync(id)
	let check = () => {
		let e = pages.essentials(id)
		expect(states.fromHistory(e)).toEqual(states.fromHistory(full()))
		expect(inbox.pending(e)).toEqual(inbox.pending(full()))
		expect(forms.open(e)?.id).toBe(forms.open(full())?.id)
	}
	check()
	turn(id, 0)
	check()
	history.submit(id, 'go')
	history.append(id, { type: 'inbox', id: 'a', text: 'steer' })
	history.append(id, { type: 'user', blocks: [{ type: 'text', text: 'steer' }], inbox: ['a'] })
	history.append(id, { type: 'inbox', id: 'b', text: 'later', queue: true })
	check()
	history.append(id, { type: 'command', text: '/model' })
	history.append(id, { type: 'question', id: 'm', form: { text: 'Model?', fields: [{ type: 'text', name: 'm' }] }, from: { command: 'model', args: '' } })
	check()
	history.append(id, { type: 'answer', question: 'm', answers: { m: 'x' } })
	check()
	history.append(id, { type: 'turn_end', status: 'error', error: 'boom', usage: {} })
	check()
	// Written by someone else, then by an older host with no marks.
	appendFileSync(history.file(id), lines.encode({ type: 'continue', ts: new Date().toISOString() }))
	check()
	pages.reset()
	expect(existsSync(`${paths.sessionDir(id)}/marks.ason`)).toBe(true)
	rmSync(`${paths.sessionDir(id)}/marks.ason`)
	check()
})

test('a history cut short (a partial last record repaired away) rebuilds the marks', () => {
	let id = newSession()
	turn(id, 0)
	let size = statSync(history.file(id)).size
	history.submit(id, 'second')
	pages.essentials(id)
	let records: HistoryRecord[] = history.readSync(id).slice(0, 3)
	writeFileSync(history.file(id), records.map((r) => lines.encode(r)).join(''))
	expect(statSync(history.file(id)).size).toBe(size)
	expect(states.fromHistory(pages.essentials(id))).toEqual({ type: 'idle' })
})

test('big marks from before the changed-file count convert off the thread, keeping their place', async () => {
	let id = newSession()
	turn(id, 0)
	let size = pages.marks(id).size
	pages.reset()
	let file = `${paths.sessionDir(id)}/marks.ason`
	let old = ason.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
	old.changedPaths = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`/some/long/path/to/file-${i}.ts`, true]))
	writeFileSync(file, ason.stringify(old) + '\n')
	expect(statSync(file).size).toBeGreaterThan(marksWorker.bigMarks)
	await marksWorker.upgrade([id])
	let now = ason.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
	expect(now.changedPaths).toBeUndefined()
	expect(now.files).toBe(5000)
	expect(pages.marks(id)).toMatchObject({ size, files: 5000 })
})
