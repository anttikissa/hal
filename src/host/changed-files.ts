// The count of distinct files a session's calls changed, kept in its
// history marks (pages.ts) as `files` beside the offsets of the
// file_changes records since the last /changes clear (task fz). The
// paths themselves stay in memory only: one call can declare a whole
// tree (130k paths made marks.ason 15 MB, ~800 ms to load, task 7j), so
// they are rebuilt from those records when a new one needs them.

import { resolve } from 'path'
import type { HistoryRecord } from '../common/replay.ts'
import { pages } from './pages.ts'

type Counted = { changes?: number[]; files?: number; changedPaths?: Record<string, true> }

function add(seen: Set<string>, r: HistoryRecord): void {
	if (r.type === 'file_changes') for (let file of r.files) if (!file.undeclared) seen.add(resolve(r.cwd, file.path))
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
	let seen = changedFiles.paths(m, path)
	m.changes.push(offset)
	changedFiles.add(seen, r)
	m.files = seen.size
}

function reset(m: Counted): void {
	m.changes = []
	m.files = 0
	changedFiles.state.paths.set(m, new Set())
}

// Marks from before `files` kept every path: only the count stays.
function upgrade(m: Counted): void {
	if (!('changedPaths' in m)) return
	m.files = Object.keys(m.changedPaths ?? {}).length
	delete m.changedPaths
}

export const changedFiles = {
	state: { paths: new WeakMap<object, Set<string>>() },
	add, paths, apply, reset, upgrade,
}
