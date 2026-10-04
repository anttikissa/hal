// Worker entry. Importing this module in the host does no work.
import { isMainThread } from 'worker_threads'
import { statSync } from 'fs'
import { findQuery, type FindBatch, type FindFilter, type FindKind, type FindQuery, type FindResult } from '../common/find.ts'
import { history } from './history.ts'
import { paths } from './paths.ts'
import { findIndex, type FindRow } from './find-index.ts'
import { replay } from '../common/replay.ts'
import type { SessionMeta } from './sessions.ts'

type Search = { channel: string; request: string; query: string; kinds?: FindFilter[]; meta?: SessionMeta[] }
type Reply = { channel: string; batch: FindBatch }

function eligible(meta: SessionMeta, q: FindQuery): boolean {
	return (!q.model || meta.model.toLocaleLowerCase().includes(q.model)) && (!q.cwd || meta.cwd.toLocaleLowerCase().includes(q.cwd))
}

function hit(row: FindRow, q: FindQuery, now: number): FindResult | undefined {
	let meta = findIndex.state.meta.get(row.sessionId)
	if (!meta || !findWorker.eligible(meta, q)) return
	let age = Math.max(0, now - row.ts)
	if (q.since !== undefined && age > q.since) return
	let match = findQuery.match(row.text, q.words, age)
	if (!match) return
	return { sessionId: row.sessionId, name: meta.name ?? '', blockId: row.blockId, kind: row.kind, age, ...match, href: `/${row.sessionId}${row.blockId ? '#' + row.blockId : ''}` }
}

function candidates(kind: FindKind, q: FindQuery): Iterable<FindRow> {
	let db = findIndex.state.db!, words = q.words.filter((w) => [...w].length >= 3)
	if (!words.length) return db.query('SELECT * FROM docs WHERE kind=?').iterate(kind) as Iterable<FindRow>
	let quote = (w: string) => '"' + w.replaceAll('"', '""') + '"'
	let grams = words.map(quote).join(' AND ')
	let tokens = q.words.filter((w) => /^[\p{L}\p{N}_]+$/u.test(w)).map((w) => quote(w) + '*').join(' AND ')
	return db.query(`SELECT * FROM docs WHERE kind=? AND id IN
		(SELECT rowid FROM grams WHERE grams MATCH ? ${tokens ? 'UNION SELECT rowid FROM words WHERE words MATCH ?' : ''})`).iterate(...(tokens ? [kind, grams, tokens] : [kind, grams])) as Iterable<FindRow>
}

async function search(c: Search): Promise<void> {
	findWorker.state.active.set(c.channel, c.request)
	let current = () => findWorker.state.active.get(c.channel) === c.request
	let tier: FindKind = 'metadata'
	let send = (results: FindResult[], done = false, scanning = 0, error?: string) => {
		if (current()) postMessage({ channel: c.channel, batch: { type: 'find-results', request: c.request, tier, results, done, scanning, ...(error ? { error } : {}) } } satisfies Reply)
	}
	try {
		await findWorker.state.ready
		if (!current()) return
		for (let m of c.meta ?? []) findIndex.state.meta.set(m.id, m)
		let q = findQuery.parse(c.query, c.kinds), now = Date.now()
		if (!c.query.trim()) { send([], true); return }
		let pending: { meta: SessionMeta; offset: number }[] | undefined
		let rebuilding = new Set<string>()
		for (tier of q.kinds) {
			let hits = new Map<string, FindResult>()
			let take = (row: FindRow) => {
				let h = findWorker.hit(row, q, now)
				if (h) hits.set(`${h.sessionId}#${h.blockId}`, h)
				if (hits.size > 100) hits = new Map(top().map((h) => [`${h.sessionId}#${h.blockId}`, h]))
			}
			let top = () => [...hits.values()].sort((a, b) => b.score - a.score || a.age - b.age || a.href.localeCompare(b.href)).slice(0, 50)
			if (tier === 'metadata') {
				for (let m of findIndex.state.meta.values()) take({ sessionId: m.id, blockId: '', kind: tier, ts: Date.parse(m.createdAt), text: `${m.id} ${m.name ?? ''} ${m.model} ${m.cwd}` })
				send(top()); await Bun.sleep(0); if (!current()) return
				continue
			}
			let started = performance.now()
			// Capture fallback offsets once before yielding while querying SQLite.
			if (!pending) {
				pending = []
				for (let m of findIndex.state.meta.values()) {
					if (!findWorker.eligible(m, q)) continue
					let stat = statSync(history.file(m.id), { throwIfNoEntry: false }), mark = findIndex.mark(m.id)
					let offset = mark?.offset ?? 0
					if (mark && stat && (stat.size < offset || (stat.size === mark.size && stat.mtimeMs !== mark.mtime))) { offset = 0; rebuilding.add(m.id) }
					if ((stat?.size ?? 0) > offset) { pending.push({ meta: m, offset }); rebuilding.add(m.id) }
					if (performance.now() - started > 4) { await Bun.sleep(0); started = performance.now(); if (!current()) return }
				}
				pending.sort((a, b) => Date.parse(b.meta.createdAt) - Date.parse(a.meta.createdAt))
			}
			for (let row of findWorker.candidates(tier, q)) {
				if (!rebuilding.has(row.sessionId)) take(row)
				if (performance.now() - started > 4) {
					await Bun.sleep(0); started = performance.now(); if (!current()) return
				}
			}
			send(top(), false, pending.length)
			for (let [i, p] of pending.entries()) {
				let raw = []
				for await (let item of findIndex.records(p.meta.id, 0)) raw.push(item.record)
				for (let record of replay.current(raw)) {
					if (!current()) return
					for (let row of await findIndex.rows(p.meta.id, record)) if (row.kind === tier) take(row)
				}
				send(top(), false, pending.length - i - 1)
				await Bun.sleep(0); if (!current()) return
			}
		}
		send([], true)
	} catch (e: any) { send([], true, 0, String(e?.message ?? e)) }
}

async function drain(): Promise<void> {
	if (findWorker.state.indexing) return
	findWorker.state.indexing = true
	try {
		for (let id of findWorker.state.dirty) {
			findWorker.state.dirty.delete(id)
			await findIndex.catchup(id)
			await Bun.sleep(0)
		}
		postMessage({ indexed: true })
	} catch (e: any) { postMessage({ error: String(e?.message ?? e) }) }
	finally { findWorker.state.indexing = false }
}

async function init(home: string): Promise<void> {
	paths.home = () => home
	findIndex.init()
	await findIndex.catalog()
	for (let id of findIndex.state.meta.keys()) findWorker.state.dirty.add(id)
	postMessage({ catalog: findIndex.state.meta.size })
	void findWorker.drain()
}

export const findWorker = { state: { ready: Promise.resolve(), active: new Map<string, string>(), dirty: new Set<string>(), indexing: false }, eligible, hit, candidates, search, drain, init }

if (!isMainThread) {
	globalThis.onmessage = (event: MessageEvent) => {
		let c = event.data
		if (c.type === 'init') {
			findWorker.state.ready = findWorker.init(c.home)
			void findWorker.state.ready.catch((e) => postMessage({ error: String(e?.message ?? e) }))
		}
		else if (c.type === 'search') void findWorker.search(c)
		else if (c.type === 'cancel') findWorker.state.active.delete(c.channel)
		else if (c.type === 'dirty') {
			if (c.meta) findIndex.state.meta.set(c.meta.id, c.meta)
			findWorker.state.dirty.add(c.sessionId)
			void findWorker.state.ready.then(() => findWorker.drain())
		}
	}
}
