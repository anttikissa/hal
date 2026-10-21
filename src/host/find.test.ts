import { afterEach, beforeEach, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { Database } from 'bun:sqlite'
import { findQuery, type FindBatch } from '../common/find.ts'
import { lines } from '../common/lines.ts'
import { ansi } from '../client/ansi.ts'
import { markdownView } from '../client/markdown-view.ts'
import { host } from './host.ts'
import { find } from './find.ts'
import { findIndex } from './find-index.ts'
import { findWorker } from './find-worker.ts'
import { history } from './history.ts'
import { paths } from './paths.ts'
import { sessions } from './sessions.ts'
import { blobs } from './blobs.ts'
import { pages } from './pages.ts'

let savedHome = paths.state.home,
	home = '',
	originalIndexed = find.indexed
beforeEach(() => {
	home = mkdtempSync(`${tmpdir()}/hal-find-`)
	paths.state.home = home
	paths.init()
})
afterEach(() => {
	host.reset()
	sessions.closeAll()
	find.indexed = originalIndexed
	if (savedHome === undefined) paths.state.home = undefined
	else paths.state.home = savedHome
	rmSync(home, { recursive: true, force: true })
})
function caughtUp(): Promise<void> {
	return new Promise((resolve) => {
		find.indexed = resolve
	})
}
function search(query: string): Promise<FindBatch[]> {
	return new Promise((resolve, reject) => {
		let owner = {},
			batches: FindBatch[] = []
		find.search(owner, crypto.randomUUID(), query, undefined, (batch) => {
			batches.push(batch)
			if (batch.done) {
				find.cancel(owner)
				if (batch.error) reject(new Error(batch.error))
				else resolve(batches)
			}
		})
	})
}

test('ranking requires every word, distinguishes word/prefix/substring and decays across kinds', () => {
	let whole = findQuery.match('A CACHE hit', ['cache', 'hit'], 0)!
	let prefix = findQuery.match('cached hit', ['cache', 'hit'], 0)!
	let substring = findQuery.match('uncached hit', ['cache', 'hit'], 0)!
	expect(whole.score).toBeGreaterThan(prefix.score)
	expect(prefix.score).toBeGreaterThan(substring.score)
	expect(findQuery.match('cache miss', ['cache', 'hit'], 0)).toBeUndefined()
	expect(findQuery.match('cache hit', ['cache', 'hit'], 86400000)!.score).toBeGreaterThan(
		findQuery.match('cache hit', ['cache', 'hit'], 864000000)!.score,
	)
	// Recency lifts a recent prefix hit over an old whole-word one, but an
	// old exact match (such as a command) still beats any recent inexact one.
	let day = 86400000
	expect(findQuery.match('cached hits', ['cache', 'hit'], 0)!.score).toBeGreaterThan(
		findQuery.match('a cache and a hit', ['cache', 'hit'], 30 * day)!.score,
	)
	expect(findQuery.match('/help security', ['help', 'security'], 90 * day)!.score).toBeGreaterThan(
		findQuery.match('help with security', ['help', 'security'], 0)!.score,
	)
})

test('worker projection streams tiers, catches durable appends, indexes blobs and rebuilds byte-stable links', async () => {
	let a = sessions.create({ cwd: '/example/project', model: 'example/model', name: 'Cache work' })
	let blob = blobs.store(a.id, 'text/plain', Buffer.from('A unique needleblob token').toString('base64'))
	history.submit(a.id, `Search the Cache ${blob.marker}`)
	history.append(a.id, { type: 'assistant', block: { type: 'thinking', text: 'cached internals' } })
	history.append(a.id, {
		type: 'assistant',
		block: { type: 'tool_call', id: 'a', name: 'bash', input: { description: 'cache metrics' } },
	})
	history.append(a.id, { type: 'user', blocks: [{ type: 'tool_result', id: 'a', output: 'uncached output' }] })
	history.append(a.id, {
		type: 'output',
		text: '1234abcd Tune cache\n+1 -0 a.ts',
		commit: { hash: '1234abcd00', short: '1234abcd', subject: 'Tune cache', files: [], tags: ['+1 LOC'] },
	})
	history.append(a.id, { type: 'round', usage: { input: 1, output: 1 } as any, model: 'cache/model' })
	let before = readFileSync(history.file(a.id))
	let ready = caughtUp()
	find.init()
	await ready
	let batches = await search('cache')
	expect(batches.filter((b) => !b.done).map((b) => b.tier)).toEqual([
		'metadata',
		'user',
		'assistant',
		'thinking',
		'tool-call',
		'tool-output',
		'commit',
		'other',
	])
	expect((await find.top('needleblob'))[0]?.blockId).toBe('1')
	expect((await find.top('in:tools cache')).map((h) => h.kind)).toEqual(['tool-call', 'tool-output'])
	expect(await find.top('cache cwd:/wrong')).toEqual([])
	expect(await find.top('cache model:other')).toEqual([])
	// Commit cards match their title; plumbing like rounds is not indexed.
	expect((await find.top('commit tune')).map((h) => [h.kind, h.snippet])).toEqual([
		['commit', 'Commit 1234abcd (Tune cache): +1 LOC'],
	])
	expect(await find.top('in:other cache')).toEqual([])
	ready = caughtUp()
	history.append(a.id, { type: 'assistant', block: { type: 'text', text: 'incremental uniquenew' } })
	await ready
	let hit = (await find.top('uniquenew'))[0]!
	let web = ansi.state.web
	try {
		ansi.state.web = { url: 'https://hal.example', code: 'example-code' }
		expect(markdownView.lines(`[found](${hit.href})`, 80).join('')).toContain(
			`https://hal.example/${a.id}?auth=example-code#7`,
		)
	} finally {
		ansi.state.web = web
	}
	expect(hit.href).toBe(`/${a.id}#7`)
	find.reset()
	let db = new Database(`${home}/state/find.sqlite`, { readonly: true })
	expect((db.query('SELECT offset FROM marks WHERE sessionId=?').get(a.id) as { offset: number }).offset).toBe(
		readFileSync(history.file(a.id)).length,
	)
	db.close()
	expect(readFileSync(history.file(a.id)).subarray(0, before.length)).toEqual(before)
	rmSync(`${home}/state/find.sqlite`)
	ready = caughtUp()
	find.init()
	await ready
	expect((await find.top('uniquenew'))[0]?.href).toBe(hit.href)
}, 10000)

test('a history rewritten under its index mark is reindexed, not a find failure', async () => {
	let a = sessions.create({ cwd: '/example', model: 'example/model' })
	let user = (text: string) =>
		lines.encode({ type: 'user', blocks: [{ type: 'text', text }], ts: new Date().toISOString() })
	appendFileSync(history.file(a.id), user('first oldneedle') + user('second'))
	let ready = caughtUp()
	find.init()
	await ready
	// Longer first record: the old end offset now falls mid-line.
	writeFileSync(history.file(a.id), user('first rewritten oldneedle') + user('second') + user('third newneedle'))
	ready = caughtUp()
	find.dirty(a.id)
	await ready
	expect((await find.top('newneedle')).length).toBe(1)
	expect((await find.top('rewritten')).length).toBe(1)
}, 10000)

test('unindexed history is searched and a new query suppresses the old stream', async () => {
	let a = sessions.create({ cwd: '/example', model: 'example/model' })
	// Legacy unnumbered records use byte offsets, not array positions.
	let prefix = lines.encode({ type: 'user', blocks: [{ type: 'text', text: 'before' }], ts: new Date().toISOString() })
	let record = lines.encode({
		type: 'assistant',
		block: { type: 'text', text: 'fallbackneedle' },
		ts: new Date().toISOString(),
	})
	appendFileSync(history.file(a.id), prefix)
	let ready = caughtUp()
	find.init()
	await ready
	// Deliberately do not notify the index: the query must scan this tail.
	appendFileSync(history.file(a.id), record)
	let owner = {},
		batches: FindBatch[] = []
	let complete = new Promise<void>((resolve) => {
		find.search(owner, 'old', 'before', undefined, (b) => batches.push(b))
		find.search(owner, 'new', 'fallbackneedle', undefined, (b) => {
			batches.push(b)
			if (b.done) resolve()
		})
	})
	await complete
	find.cancel(owner)
	expect(batches.filter((b) => b.request === 'old')).toEqual([])
	expect(batches.some((b) => (b.scanning ?? 0) > 0)).toBe(true)
	let hits = batches.flatMap((b) => b.results)
	expect(hits.some((h) => h.href === `/${a.id}#${Buffer.byteLength(prefix) + 1}`)).toBe(true)
}, 10000)

test('rename search exposes old and new titles from both origins, including old history and stale projections', async () => {
	let a = sessions.create({ cwd: '/example', model: 'example/model', name: 'Current topic' })
	history.append(a.id, { type: 'command', text: '/rename Human topic' })
	history.append(a.id, { type: 'output', text: 'Session renamed: Earlier topic → Human topic' })
	history.append(a.id, { type: 'command', text: '/rename Model topic', origin: 'model' })
	history.append(a.id, { type: 'output', text: '/rename: Human topic → Model topic', origin: 'model' })
	for (let i = 0; i < 80; i++) history.submit(a.id, `Later conversation ${i}`)
	// A small opening page leaves the rename records loaded on demand.
	let tail = pages.snapshot(a.id, 1024)
	expect(tail.older).toBeDefined()
	expect(tail.history.some((r) => r.type === 'command' || r.type === 'output')).toBe(false)
	let before = readFileSync(history.file(a.id))
	let ready = caughtUp()
	find.init()
	await ready
	let verify = async () => {
		let hits = await find.top('/rename')
		expect(
			hits
				.filter((h) => h.kind === 'other')
				.map((h) => h.blockId)
				.sort(),
		).toEqual(['1', '2', '3', '4'])
		expect(hits.find((h) => h.blockId === '2')?.snippet).toContain('Earlier topic → Human topic')
		expect(hits.find((h) => h.blockId === '4')?.snippet).toContain('Human topic → Model topic')
		expect(hits.find((h) => h.blockId === '2')?.href).toBe(`/${a.id}#2`)
		expect(hits.find((h) => h.blockId === '4')?.href).toBe(`/${a.id}#4`)
	}
	await verify()
	find.reset()
	// An old fully caught-up projection must be rebuilt, not just its tail.
	let db = new Database(`${home}/state/find.sqlite`)
	db.exec("DELETE FROM docs WHERE blockId='2'; PRAGMA user_version=0;")
	db.close()
	ready = caughtUp()
	find.init()
	await ready
	await verify()
	// Unnotified appends exercise the same projection during fallback scans.
	appendFileSync(
		history.file(a.id),
		lines.encode({
			type: 'output',
			text: 'Session renamed: Model topic → Final topic',
			origin: 'model',
			n: 85,
			ts: new Date().toISOString(),
		}),
	)
	expect((await find.top('/rename')).find((h) => h.blockId === '85')?.snippet).toContain('Model topic → Final topic')
	expect(readFileSync(history.file(a.id)).subarray(0, before.length)).toEqual(before)
}, 10000)

test('overlapping searches iterate SQLite candidates independently', () => {
	// A search pauses mid-cursor; a newer one must not share its statement (SQLITE_MISUSE).
	findIndex.init()
	let db = findIndex.state.db!
	for (let i = 0; i < 4; i++)
		db.query('INSERT INTO docs(sessionId,blockId,kind,ts,text) VALUES(?,?,?,?,?)').run(
			's',
			`b${i}`,
			'user',
			0,
			`needle ${i}`,
		)
	for (let query of ['w', 'needle']) {
		let q = findQuery.parse(query, undefined)
		let old = findWorker.candidates('user', q)[Symbol.iterator]()
		old.next()
		let fresh = [...findWorker.candidates('user', q)]
		expect(fresh.length).toBe(4)
		expect(old.next().done).toBe(false)
		old.return?.(undefined)
	}
	db.close()
})
