// Rebuildable SQLite projection. Used only in the find worker: parsing a
// giant ASON line or SQLite call must never hold up the host event loop.
import { Database } from 'bun:sqlite'
import { createReadStream, existsSync, statSync } from 'fs'
import { ason } from '../common/ason.ts'
import { attachments } from '../common/attachments.ts'
import type { FindKind } from '../common/find.ts'
import { replay, type HistoryRecord } from '../common/replay.ts'
import { blobs } from './blobs.ts'
import { history } from './history.ts'
import { liveFiles } from './live-file.ts'
import { paths } from './paths.ts'
import { sessions, type SessionMeta } from './sessions.ts'

export type FindRow = { sessionId: string; blockId: string; kind: FindKind; ts: number; text: string }
type Mark = { offset: number; size: number; mtime: number }

function init(): void {
	paths.init()
	let db = new Database(`${paths.stateDir()}/find.sqlite`, { create: true })
	findIndex.state.db = db
	// The projection is disposable; version changes reindex immutable history.
	if ((db.query('PRAGMA user_version').get() as { user_version: number }).user_version !== 1) {
		db.exec('DROP TABLE IF EXISTS docs; DROP TABLE IF EXISTS words; DROP TABLE IF EXISTS grams; DROP TABLE IF EXISTS marks; PRAGMA user_version=1;')
	}
	db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
		CREATE TABLE IF NOT EXISTS marks (sessionId TEXT PRIMARY KEY, offset INTEGER, size INTEGER, mtime REAL);
		CREATE TABLE IF NOT EXISTS docs (id INTEGER PRIMARY KEY, sessionId TEXT, blockId TEXT, kind TEXT, ts REAL, text TEXT, UNIQUE(sessionId,blockId));
		CREATE INDEX IF NOT EXISTS doc_kind ON docs(kind);
		CREATE VIRTUAL TABLE IF NOT EXISTS words USING fts5(text, content='docs', content_rowid='id', tokenize='unicode61');
		CREATE VIRTUAL TABLE IF NOT EXISTS grams USING fts5(text, content='docs', content_rowid='id', tokenize='trigram');
		CREATE TRIGGER IF NOT EXISTS doc_insert AFTER INSERT ON docs BEGIN
			INSERT INTO words(rowid,text) VALUES(new.id,new.text); INSERT INTO grams(rowid,text) VALUES(new.id,new.text); END;
		CREATE TRIGGER IF NOT EXISTS doc_delete AFTER DELETE ON docs BEGIN
			INSERT INTO words(words,rowid,text) VALUES('delete',old.id,old.text); INSERT INTO grams(grams,rowid,text) VALUES('delete',old.id,old.text); END;`)
}

async function catalog(): Promise<void> {
	for (let id of sessions.ids()) {
		let meta = sessions.load(id, false)
		findIndex.state.meta.set(id, { ...meta })
		liveFiles.close(meta)
		await Bun.sleep(0)
	}
}

// Only session-owned text blobs. Do not resolve staged markers (that may
// copy files); search is read-only with respect to conversation truth.
async function text(sessionId: string, value: string): Promise<string> {
	let parts = [value]
	let ids = new Set<string>()
	for (let m of attachments.markers(value)) {
		if (m.kind === 'image') continue
		let path = m.file ? `${blobs.dir(sessionId)}/${m.file}` : blobs.find(sessionId, m.blob)?.path
		if (path && existsSync(path)) parts.push(await Bun.file(path).slice(0, 65536).text())
		ids.add(m.blob)
	}
	for (let m of value.matchAll(/whole output in blob ([a-f0-9]{12})/g)) {
		if (ids.has(m[1]!)) continue
		let found = blobs.find(sessionId, m[1]!)
		if (found) parts.push(await Bun.file(found.path).slice(0, 65536).text())
	}
	return Buffer.from(parts.join('\n')).subarray(0, 65536).toString('utf8')
}

async function rows(sessionId: string, r: HistoryRecord): Promise<FindRow[]> {
	let out: FindRow[] = [], ts = Date.parse(r.ts)
	let add = async (kind: FindKind, value: string, i = 0) => {
		out.push({ sessionId, blockId: i ? `${r.n}.${i}` : `${r.n}`, kind, ts, text: await findIndex.text(sessionId, value) })
	}
	if (r.type === 'user' || r.type === 'assistant') {
		let blocks = r.type === 'user' ? r.blocks : [r.block]
		for (let [i, b] of blocks.entries()) {
			if (b.type === 'text') await add(r.type, b.text, i)
			else if (b.type === 'thinking') await add('thinking', b.text, i)
			else if (b.type === 'tool_call') await add('tool-call', `${b.name} ${ason.stringify(b.input, 'short')}`, i)
			else if (b.type === 'tool_result') await add('tool-output', b.output, i)
		}
	} else if (r.type === 'command' || r.type === 'output') {
		// Older successful rename replies lack the command name. Keep them
		// discoverable without changing history or maintaining a title store.
		let legacyRename = r.type === 'output' && !r.error && r.text.startsWith('Session renamed: ')
		await add('other', legacyRename ? `/rename ${r.text}` : r.text)
	} else await add('other', ason.stringify(r, 'short'))
	return out
}

async function* records(sessionId: string, offset: number): AsyncGenerator<{ record: HistoryRecord; end: number }> {
	let path = history.file(sessionId)
	if (!existsSync(path)) return
	let pending = Buffer.alloc(0), at = offset, started = performance.now()
	for await (let chunk of createReadStream(path, { start: offset, highWaterMark: 16384 })) {
		pending = Buffer.concat([pending, chunk as Buffer])
		let from = 0, end: number
		while ((end = pending.indexOf(10, from)) >= 0) {
			let line = pending.subarray(from, end).toString('utf8')
			if (line.trim()) {
				try {
					let record = history.check(ason.parse(line))
					record.n ??= at + from + 1
					yield { record, end: at + end + 1 }
				} catch (e: any) { throw new Error(`${path}:${at + from}: ${e?.message ?? e}`) }
			}
			from = end + 1
			if (performance.now() - started > 4) { await Bun.sleep(0); started = performance.now() }
		}
		at += from
		pending = pending.subarray(from)
	}
	// A torn final line stays untouched and is not projected.
}

function mark(sessionId: string): Mark | undefined {
	return findIndex.state.db!.query('SELECT offset,size,mtime FROM marks WHERE sessionId=?').get(sessionId) as Mark | undefined
}

function start(sessionId: string): number {
	let m = findIndex.mark(sessionId), stat = statSync(history.file(sessionId), { throwIfNoEntry: false })
	if (!m || !stat) return 0
	return stat.size < m.offset || (stat.size === m.size && stat.mtimeMs !== m.mtime) ? 0 : m.offset
}

async function catchup(sessionId: string): Promise<void> {
	let db = findIndex.state.db!, offset = findIndex.start(sessionId)
	if (!offset) db.query('DELETE FROM docs WHERE sessionId=?').run(sessionId)
	let batch: FindRow[] = [], end = offset
	let flush = () => db.transaction(() => {
		for (let row of batch) db.query('INSERT OR IGNORE INTO docs(sessionId,blockId,kind,ts,text) VALUES(?,?,?,?,?)').run(row.sessionId, row.blockId, row.kind, row.ts, row.text)
		let stat = statSync(history.file(sessionId), { throwIfNoEntry: false })
		db.query('INSERT OR REPLACE INTO marks VALUES(?,?,?,?)').run(sessionId, end, stat?.size ?? 0, stat?.mtimeMs ?? 0)
		batch = []
	})()
	let items = []
	for await (let item of findIndex.records(sessionId, offset)) items.push(item)
	if (items.some((i) => i.record.type === 'rebase' || (i.record.type === 'user' && i.record.replaces))) {
		items = []
		for await (let item of findIndex.records(sessionId, 0)) items.push(item)
		db.query('DELETE FROM docs WHERE sessionId=?').run(sessionId)
		end = items.at(-1)?.end ?? 0
		items = replay.current(items.map((i) => i.record)).map((record) => ({ record, end }))
	}
	for (let item of items) {
		batch.push(...await findIndex.rows(sessionId, item.record)); end = item.end
		if (batch.length >= 16) { flush(); await Bun.sleep(0) }
	}
	flush()
}

export const findIndex = { state: { db: undefined as Database | undefined, meta: new Map<string, SessionMeta>() }, init, catalog, text, rows, records, mark, start, catchup }
