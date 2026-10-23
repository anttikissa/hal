// Entry point of the find worker, which keeps search off the host's
// thread. Importing this module in the host does no work. A query answers
// "which tab did this?": hits fold into one row per tab before the result
// limit (task yhm).
import { isMainThread } from 'worker_threads'
import { statSync } from 'fs'
import { homedir } from 'os'
import {
	findQuery,
	type FindBatch,
	type FindFilter,
	type FindKind,
	type FindQuery,
	type FindResult,
} from '../common/find.ts'
import { history } from './history.ts'
import { paths } from './paths.ts'
import { findIndex, type FindRow } from './find-index.ts'
import { replay } from '../common/replay.ts'
import type { SessionMeta } from './sessions.ts'
// `here`: the tab Find opened from; `tabs`: the open tabs in order, from
// the host (in:).
type Search = {
	channel: string
	request: string
	query: string
	kinds?: FindFilter[]
	here?: string
	tabs?: string[]
	limit?: number
	meta?: SessionMeta[]
}
type Reply = { channel: string; batch: FindBatch }
// What every hit in one search shares: the query, its sessions, and
// whether rows fold into tabs.
type Context = { q: FindQuery; now: number; ids?: Set<string>; tabs: boolean }
type Tab = { best: FindResult; count: number; strong: Set<string>; strongCount: number; age: number }

// The label naming why a row matched.
const why: Record<FindKind, string> = {
	metadata: 'title',
	commit: 'commit',
	user: 'request',
	assistant: 'reply',
	thinking: 'reasoning',
	'tool-call': 'tool',
	'tool-output': 'tool',
	other: 'other',
}

function hit(row: FindRow, c: Context): FindResult | undefined {
	let meta = findIndex.state.meta.get(row.sessionId)
	if (!meta || (c.ids && !c.ids.has(row.sessionId))) return
	let q = c.q,
		age = Math.max(0, c.now - row.ts)
	if (q.since !== undefined && age > q.since) return
	// A fork's history before its creation belongs to its origin.
	if (c.tabs && meta.forkedFrom && findIndex.state.meta.has(meta.forkedFrom) && row.ts < Date.parse(meta.createdAt))
		return
	if (q.exclude.length) {
		let haystack = `${row.sessionId} ${meta.name ?? ''} ${row.text}`.toLocaleLowerCase()
		if (q.exclude.some((w) => haystack.includes(w))) return
	}
	let match = findQuery.match(row.text, q.words, q.phrases)
	if (!match) return
	let label = row.blockId === 'cwd' ? 'cwd' : why[row.kind]
	// A commit shows its title line, which names the hash and subject.
	if (row.kind === 'commit') match.snippet = row.text.split('\n')[0]!
	// A title or cwd match links to the tab itself.
	let block = row.kind === 'metadata' ? '' : row.blockId
	return {
		sessionId: row.sessionId,
		name: meta.name ?? '',
		cwd: findWorker.home(meta.cwd),
		blockId: block,
		card: row.card + block,
		kind: row.kind,
		why: label,
		count: 0,
		age,
		snippet: match.snippet,
		score: findQuery.weights[label]! * match.quality,
		href: `/${row.sessionId}${block ? '#' + block : ''}`,
	}
}

function home(dir: string): string {
	let h = paths.home()
	return dir === h || dir.startsWith(h + '/') ? '~' + dir.slice(h.length) : dir
}

// The sessions an in: scope names, or undefined for every session.
function scope(q: FindQuery, here: string | undefined, tabs: string[]): Set<string> | undefined {
	if (!q.scope.length) return undefined
	let meta = findIndex.state.meta,
		ids = new Set<string>()
	let current = () => {
		if (!here || !meta.has(here)) throw new Error('in:here and in:. need the tab Find was opened from')
		return here
	}
	for (let v of q.scope) {
		let range = /^(\d+)(?:-(\d+))?$/.exec(v)
		if (v.toLowerCase() === 'here') ids.add(current())
		else if (/^\d+-[a-z]{3}$/i.test(v)) {
			if (!meta.has(v.toLowerCase())) throw new Error(`in: no session ${v}`)
			ids.add(v.toLowerCase())
		} else if (range) {
			let from = Number(range[1]),
				to = Number(range[2] ?? range[1])
			let found = tabs.slice(Math.min(from, to) - 1, Math.max(from, to))
			if (!found.length) throw new Error(`in: no tab ${v}`)
			for (let id of found) ids.add(id)
		} else {
			let dir = v === '.' ? meta.get(current())!.cwd : v.replace(/^~(?=\/|$)/, homedir())
			dir = dir.replace(/\/+$/, '') || '/'
			for (let m of meta.values()) if (m.cwd === dir || m.cwd.startsWith(dir === '/' ? '/' : dir + '/')) ids.add(m.id)
		}
	}
	return ids
}

// Score order: relevance first; recency breaks ties between scores that
// round alike.
function order(a: FindResult, b: FindResult): number {
	return Math.round(b.score) - Math.round(a.score) || a.age - b.age || a.href.localeCompare(b.href)
}

// One row per tab: its best evidence, the number of matching cards, and
// a bonus for each kind of strong evidence and for their count.
function group(): { add(h: FindResult): void; top(n: number): FindResult[] } {
	let tabs = new Map<string, Tab>()
	return {
		add(h) {
			let t = tabs.get(h.sessionId)
			if (!t) tabs.set(h.sessionId, (t = { best: h, count: 0, strong: new Set(), strongCount: 0, age: h.age }))
			t.count++
			t.age = Math.min(t.age, h.age)
			if (findQuery.strong.includes(h.why)) {
				t.strong.add(h.why)
				if (h.why === 'commit' || h.why === 'request') t.strongCount++
			}
			if (h.score > t.best.score) t.best = h
		},
		top(n) {
			return [...tabs.values()]
				.map((t) => ({
					...t.best,
					count: t.count,
					age: t.age,
					score: t.best.score + 10 * t.strong.size + Math.min(5, Math.log2(1 + t.strongCount)),
				}))
				.sort(findWorker.order)
				.slice(0, n)
		},
	}
}

// Each call prepares its own statement. db.query() caches one statement per
// SQL text, and search() pauses mid-iteration; a newer search reusing that
// statement then failed with SQLITE_MISUSE ("bad parameter or other API
// misuse") while the older cursor was still open.
function* candidates(kind: FindKind, q: FindQuery, ids?: Set<string>): Generator<FindRow> {
	let db = findIndex.state.db!,
		terms = [...q.words, ...q.phrases].filter((w) => [...w].length >= 3)
	let quote = (w: string) => '"' + w.replaceAll('"', '""') + '"'
	let grams = terms.map(quote).join(' AND ')
	let tokens = q.words
		.filter((w) => /^[\p{L}\p{N}_]+$/u.test(w))
		.map((w) => quote(w) + '*')
		.join(' AND ')
	let sql = 'SELECT * FROM docs WHERE kind=?',
		args: (string | number)[] = [kind]
	if (ids) {
		sql += ' AND sessionId IN (SELECT value FROM json_each(?))'
		args.push(JSON.stringify([...ids]))
	}
	if (q.since !== undefined) {
		sql += ' AND ts>=?'
		args.push(Date.now() - q.since)
	}
	if (terms.length) {
		sql += ` AND id IN (SELECT rowid FROM grams WHERE grams MATCH ? ${tokens && !q.phrases.length ? 'UNION SELECT rowid FROM words WHERE words MATCH ?' : ''})`
		args.push(grams)
		if (tokens && !q.phrases.length) args.push(tokens)
	}
	let stmt = db.prepare(sql)
	try {
		yield* stmt.iterate(...args) as Iterable<FindRow>
	} finally {
		stmt.finalize()
	}
}

async function search(c: Search): Promise<void> {
	findWorker.state.active.set(c.channel, c.request)
	let current = () => findWorker.state.active.get(c.channel) === c.request
	let tier: FindKind = 'metadata'
	let send = (results: FindResult[], done = false, scanning = 0, error?: string) => {
		if (current())
			postMessage({
				channel: c.channel,
				batch: { type: 'find-results', request: c.request, tier, results, done, scanning, ...(error ? { error } : {}) },
			} satisfies Reply)
	}
	let limit = c.limit ?? 50
	let kept = findWorker.state.kept.get(c.channel)
	if (kept?.request === c.request) {
		send(kept.top(limit))
		send([], true)
		return
	}
	findWorker.state.kept.delete(c.channel)
	try {
		await findWorker.state.ready
		if (!current()) return
		for (let m of c.meta ?? []) findIndex.state.meta.set(m.id, m)
		let q = findQuery.parse(c.query, c.kinds),
			now = Date.now()
		let ids = findWorker.scope(q, c.here, c.tabs ?? [])
		// No query: the sessions whose histories changed last (task 6m).
		if (!c.query.trim()) {
			let recent = [...findIndex.state.meta.values()].map((m) => ({
				m,
				at: statSync(history.file(m.id), { throwIfNoEntry: false })?.mtimeMs ?? Date.parse(m.createdAt),
			}))
			recent.sort((a, b) => b.at - a.at)
			send(
				recent.slice(0, limit).map(({ m, at }) => ({
					sessionId: m.id,
					name: m.name ?? '',
					cwd: findWorker.home(m.cwd),
					blockId: '',
					card: '',
					kind: 'metadata',
					why: '',
					count: 0,
					age: Math.max(0, now - at),
					snippet: '',
					score: at,
					href: `/${m.id}`,
				})),
			)
			send([], true)
			return
		}
		// One scoped tab lists its cards; otherwise one row per tab.
		let ctx: Context = { q, now, ids, tabs: ids?.size !== 1 }
		let tabs = findWorker.group(),
			cards = new Map<string, FindResult>()
		let take = (row: FindRow) => {
			let h = findWorker.hit(row, ctx)
			if (!h) return
			if (ctx.tabs) return tabs.add(h)
			let key = `${h.sessionId}#${h.blockId}#${h.kind}`
			if (!cards.has(key) || h.score > cards.get(key)!.score) cards.set(key, h)
		}
		let ranked = (n: number) => (ctx.tabs ? tabs.top(n) : [...cards.values()].sort(findWorker.order).slice(0, n))
		let top = () => ranked(limit)
		findWorker.state.kept.set(c.channel, { request: c.request, top: ranked })
		let pending: { meta: SessionMeta; offset: number }[] | undefined
		let rebuilding = new Set<string>()
		let started = performance.now()
		let pause = async () => {
			if (performance.now() - started <= 4) return true
			await Bun.sleep(0)
			started = performance.now()
			return current()
		}
		for (tier of q.kinds) {
			if (tier === 'metadata') {
				for (let m of findIndex.state.meta.values()) {
					let row = { sessionId: m.id, card: '', kind: tier, ts: Date.parse(m.createdAt) }
					take({ ...row, blockId: '', text: `${m.id} ${m.name ?? ''}` })
					take({ ...row, blockId: 'cwd', text: m.cwd })
				}
				send(top())
				await Bun.sleep(0)
				if (!current()) return
				continue
			}
			started = performance.now()
			// Capture fallback offsets once before yielding while querying SQLite.
			if (!pending) {
				pending = []
				for (let m of findIndex.state.meta.values()) {
					if (ids && !ids.has(m.id)) continue
					let stat = statSync(history.file(m.id), { throwIfNoEntry: false }),
						mark = findIndex.mark(m.id)
					let offset = mark?.offset ?? 0
					if (mark && stat && (stat.size < offset || (stat.size === mark.size && stat.mtimeMs !== mark.mtime))) {
						offset = 0
						rebuilding.add(m.id)
					}
					if ((stat?.size ?? 0) > offset) {
						pending.push({ meta: m, offset })
						rebuilding.add(m.id)
					}
					if (!(await pause())) return
				}
				pending.sort((a, b) => Date.parse(b.meta.createdAt) - Date.parse(a.meta.createdAt))
			}
			for (let row of findWorker.candidates(tier, q, ids)) {
				if (!rebuilding.has(row.sessionId)) take(row)
				if (!(await pause())) return
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
				await Bun.sleep(0)
				if (!current()) return
			}
		}
		send([], true)
	} catch (e: any) {
		send([], true, 0, String(e?.message ?? e))
	}
}

async function drain(): Promise<void> {
	if (findWorker.state.indexing) return
	findWorker.state.indexing = true
	try {
		for (let id of findWorker.state.dirty) {
			findWorker.state.dirty.delete(id)
			await findIndex.catchup(id)
			findIndex.load(id)
			await Bun.sleep(0)
		}
		postMessage({ indexed: true })
	} catch (e: any) {
		postMessage({ error: String(e?.message ?? e) })
	} finally {
		findWorker.state.indexing = false
	}
}

async function init(home: string): Promise<void> {
	paths.home = () => home
	findIndex.init()
	await findIndex.catalog()
	for (let id of findIndex.state.meta.keys()) findWorker.state.dirty.add(id)
	postMessage({ catalog: findIndex.state.meta.size })
	void findWorker.drain()
}

export const findWorker = {
	home,
	state: {
		ready: Promise.resolve(),
		active: new Map<string, string>(),
		// Each channel's last ranking, for load more.
		kept: new Map<string, { request: string; top(n: number): FindResult[] }>(),
		dirty: new Set<string>(),
		indexing: false,
	},
	hit,
	scope,
	order,
	group,
	candidates,
	search,
	drain,
	init,
}

if (!isMainThread) {
	globalThis.onmessage = (event: MessageEvent) => {
		let c = event.data
		if (c.type === 'init') {
			findWorker.state.ready = findWorker.init(c.home)
			void findWorker.state.ready.catch((e) => postMessage({ error: String(e?.message ?? e) }))
		} else if (c.type === 'search') void findWorker.search(c)
		else if (c.type === 'cancel') {
			findWorker.state.active.delete(c.channel)
			findWorker.state.kept.delete(c.channel)
		} else if (c.type === 'dirty') {
			if (c.meta) findIndex.state.meta.set(c.meta.id, c.meta)
			findWorker.state.dirty.add(c.sessionId)
			void findWorker.state.ready.then(() => findWorker.drain())
		}
	}
}
