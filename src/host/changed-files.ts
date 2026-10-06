// The count of distinct files a session's calls changed, kept in its
// history marks (pages.ts) as `files` beside the offsets of the
// file_changes records since the last /changes clear (task fz). The
// paths themselves stay in memory only: one call can declare a whole
// tree (130k paths made marks.ason 15 MB, ~800 ms to load, task 7j), so
// they are rebuilt from those records when a new one needs them: in a
// worker once the history is over syncBytes (one record can be 25 MB),
// meanwhile `files` keeps its old count and new records wait.

import { statSync } from 'fs'
import { resolve } from 'path'
import type { HistoryRecord } from '../common/replay.ts'
import { diag } from './diag.ts'
import { marksWorker } from './marks-worker.ts'
import { pages } from './pages.ts'

type Counted = { changes?: number[]; files?: number; changedPaths?: Record<string, true> }

function add(seen: Set<string>, r: HistoryRecord): void {
	if (r.type === 'file_changes') for (let file of r.files) if (!file.undeclared) seen.add(resolve(r.cwd, file.path))
}

// Adds the NUL-separated `paths` to `seen`, a step per thousand.
function* fill(seen: Set<string>, paths: string): Generator<number, void, void> {
	for (let at = 0, n = 0; at < paths.length; n++) {
		if (n % 1000 === 0) yield pages.syncBytes
		let end = paths.indexOf('\0', at)
		if (end < 0) end = paths.length
		seen.add(paths.slice(at, end))
		at = end + 1
	}
}

// The distinct paths of the records at m.changes in history `path`.
function paths(m: Counted, path: string): Set<string> {
	let seen = changedFiles.state.paths.get(m)
	if (seen) return seen
	seen = new Set()
	for (let o of m.changes ?? []) changedFiles.add(seen, pages.lineAt(path, o).record)
	changedFiles.state.paths.set(m, seen)
	return seen
}

// Record `r` at `offset` of history `path`, applied to the marks.
function apply(m: Counted, r: HistoryRecord, offset: number, path: string): void {
	m.changes ??= []
	if (r.type === 'command' && r.text.trim() === '/changes clear') changedFiles.reset(m)
	if (r.type !== 'file_changes') return
	let st = changedFiles.state
	let waiting = st.waiting.get(m)
	if (waiting) return void (m.changes.push(offset), waiting.push(r))
	if (!st.paths.has(m) && m.changes.length && statSync(path).size > changedFiles.syncBytes) {
		let offsets = [...m.changes]
		let queued = [r]
		st.waiting.set(m, queued)
		m.changes.push(offset)
		let rebuild = async () => {
			let reply = await marksWorker.run({ history: path, offsets })
			if (reply.error !== undefined) throw new Error(reply.error)
			let seen = new Set<string>()
			await pages.slices(changedFiles.fill(seen, reply.paths ?? ''))
			// A /changes clear meanwhile started over.
			if (st.waiting.get(m) !== queued) return
			st.waiting.delete(m)
			for (let q of queued) changedFiles.add(seen, q)
			st.paths.set(m, seen)
			m.files = seen.size
		}
		void rebuild().catch((e) => diag.log(`changed files of ${path}: ${e?.message ?? e}`))
		return
	}
	let seen = changedFiles.paths(m, path)
	m.changes.push(offset)
	changedFiles.add(seen, r)
	m.files = seen.size
}

function reset(m: Counted): void {
	m.changes = []
	m.files = 0
	changedFiles.state.waiting.delete(m)
	changedFiles.state.paths.set(m, new Set())
}

// Marks from before `files` kept every path: only the count stays.
function upgrade(m: Counted): void {
	if (!('changedPaths' in m)) return
	m.files = Object.keys(m.changedPaths ?? {}).length
	delete m.changedPaths
}

export const changedFiles = {
	// `waiting`: records applied while the paths are rebuilt in a worker.
	state: { paths: new WeakMap<object, Set<string>>(), waiting: new WeakMap<object, HistoryRecord[]>() },
	// Histories bigger than this rebuild the paths in a worker.
	syncBytes: 1024 * 1024,
	add, fill, paths, apply, reset, upgrade,
}
