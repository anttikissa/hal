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
	find.reset()
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

test('match requires every word and phrase, and ranks word over prefix over substring', () => {
	let quality = (text: string, words: string[], phrases: string[] = []) =>
		findQuery.match(text, words, phrases)?.quality
	expect(quality('A CACHE hit', ['cache', 'hit'])!).toBeGreaterThan(quality('cached hit', ['cache', 'hit'])!)
	expect(quality('cached hit', ['cache', 'hit'])!).toBeGreaterThan(quality('uncached hit', ['cache', 'hit'])!)
	expect(quality('cache miss', ['cache', 'hit'])).toBeUndefined()
	// A command typed exactly beats the same words in prose.
	expect(quality('/help security', ['help', 'security'])!).toBeGreaterThan(
		quality('help with security', ['help', 'security'])!,
	)
	// "Quoted" phrases match whole words across whitespace only.
	expect(quality('edit the live\nfile', [], ['live file'])).toBeDefined()
	expect(quality('a live-files list', [], ['live-file'])).toBeUndefined()
	let q = findQuery.parse('"live file" rebase -conflict in:tools,10-19,here since:24h')
	expect([q.words, q.phrases, q.exclude, q.scope, q.kinds, q.since]).toEqual([
		['rebase'],
		['live file'],
		['conflict'],
		['10-19', 'here'],
		['tool-call', 'tool-output'],
		86400000,
	])
	// Values still being typed filter nothing.
	expect(findQuery.parse('x in:he since:3')).toEqual(findQuery.parse('x'))
})

test('tab rows rank authorship over mentions; inherited fork history is not evidence', async () => {
	let commit = (subject: string) => ({
		type: 'output' as const,
		text: `abcd1234 ${subject}\n+1 -0 a.ts`,
		commit: { hash: 'abcd1234ff', short: 'abcd1234', subject, files: [] },
	})
	let author = sessions.create({ cwd: '/example', model: 'example/model', name: 'Cursor work' })
	history.append(author.id, commit('Blink the cursor'))
	let chatty = sessions.create({ cwd: '/example', model: 'example/model', name: 'Chat' })
	for (let i = 0; i < 11; i++)
		history.append(chatty.id, { type: 'assistant', block: { type: 'text', text: `blink reply ${i}` } })
	let fork = sessions.create({ cwd: '/example', model: 'example/model', name: 'Fork' })
	sessions.state.open.get(fork.id)!.forkedFrom = author.id
	appendFileSync(
		history.file(fork.id),
		lines.encode({ type: 'user', blocks: [{ type: 'text', text: 'blink it' }], ts: '2000-01-01T00:00:00.000Z' }),
	)
	let ready = caughtUp()
	find.init()
	await ready
	let rows = await find.top('blink')
	expect(rows.map((r) => [r.sessionId, r.why])).toEqual([
		[author.id, 'commit'],
		[chatty.id, 'reply'],
	])
	expect(rows[1]!.count).toBe(11)
	// Load more: the same request with a higher limit resends the kept ranking.
	let owner = {}
	let page = (limit: number) =>
		new Promise<string[]>((resolve) => {
			let rows: string[] = []
			find.search(
				owner,
				'more',
				'blink',
				undefined,
				(b) => (b.done ? resolve(rows) : (rows = b.results.map((r) => r.sessionId))),
				{ limit },
			)
		})
	expect(await page(1)).toEqual([author.id])
	expect(await page(2)).toEqual([author.id, chatty.id])
	find.cancel(owner)
	// One scoped tab lists its cards.
	let cards = await find.top(`blink in:${chatty.id}`)
	expect(cards.length).toBe(11)
	expect(cards.every((c) => c.count === 0)).toBe(true)
}, 10000)

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
		'commit',
		'user',
		'assistant',
		'thinking',
		'tool-call',
		'tool-output',
		'other',
	])
	expect((await find.top('needleblob'))[0]?.blockId).toBe('1')
	expect((await find.top(`in:${a.id},tools cache`)).map((h) => h.kind)).toEqual(['tool-call', 'tool-output'])
	expect(await find.top('cache in:/wrong')).toEqual([])
	expect(new Set((await find.top('cache in:/example')).map((h) => h.sessionId))).toEqual(new Set([a.id]))
	// Commit cards match their title; plumbing like rounds is not indexed.
	expect((await find.top('commit tune')).map((h) => [h.kind, h.why, h.snippet])).toEqual([
		['commit', 'commit', 'Commit 1234abcd (Tune cache): +1 LOC'],
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
	history.submit(a.id, 'Rename: please rename the tab')
	// A small opening page leaves the rename records loaded on demand.
	let tail = pages.snapshot(a.id, 1024)
	expect(tail.older).toBeDefined()
	expect(tail.history.some((r) => r.type === 'command' || r.type === 'output')).toBe(false)
	let before = readFileSync(history.file(a.id))
	findIndex.init()
	await findIndex.catchup(a.id)
	let db = findIndex.state.db!
	db.exec("DELETE FROM docs WHERE blockId='2'; PRAGMA user_version=0;")
	db.close()
	findIndex.state.db = undefined
	let ready = caughtUp()
	find.init()
	await ready
	let verify = async () => {
		let hits = await find.top(`in:${a.id} /rename`)
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
		// The rename itself outranks requests that mention it.
		expect((await find.top(`in:${a.id} rename`))[0]?.why).toBe('command')
	}
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
	expect((await find.top(`in:${a.id} /rename`)).find((h) => h.blockId === '85')?.snippet).toContain(
		'Model topic → Final topic',
	)
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
