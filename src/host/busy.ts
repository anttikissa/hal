// Busy sessions (task zk): the small durable list, state/busy.ason, of
// sessions that may hold an unfinished turn or queued messages, so a
// new host finds work in closed tabs without reading every session on
// disk. A session joins before a prompt, continuation or inbox message
// is written (a crash in between only leaves an extra entry) and leaves
// when a turn ends with nothing waiting in its inbox, or when recovery
// finds nothing to do. Extra entries cost a look; missing ones lose work.

import { mkdirSync } from 'fs'
import type { HistoryRecord } from '../common/replay.ts'
import { liveFiles } from './live-file.ts'
import { paths } from './paths.ts'

type BusyFile = { ids: string[] }

// The home's list, read on first use. Throws if it is malformed.
function file(): BusyFile {
	let path = `${paths.stateDir()}/busy.ason`
	let known = busy.state.files.get(path)
	if (known) return known
	mkdirSync(paths.stateDir(), { recursive: true })
	let data = liveFiles.liveFile<BusyFile>(path, { ids: [] }, { watch: false })
	if (!Array.isArray(data.ids)) {
		liveFiles.close(data)
		throw new Error(`${path}: ids must be a list`)
	}
	busy.state.files.set(path, data)
	return data
}

function list(): string[] {
	return [...busy.file().ids]
}

// Written now, not on the next microtask: the record follows at once.
function add(id: string): void {
	let f = busy.file()
	if (f.ids.includes(id)) return
	f.ids.push(id)
	liveFiles.save(f)
}

function drop(id: string): void {
	let f = busy.file()
	if (!f.ids.includes(id)) return
	f.ids = f.ids.filter((x) => x !== id)
	liveFiles.save(f)
}

// Whether writing `record` may leave work for a later host.
function starts(record: { type: HistoryRecord['type']; transition?: unknown; blocks?: unknown[]; notices?: unknown }): boolean {
	return (record.type === 'output' && record.transition !== undefined) || (record.type === 'user' && (record.notices === undefined || !!record.blocks?.length)) || record.type === 'continue' || record.type === 'inbox'
}

// Forgets the loaded files, writing pending changes (tests, restart).
function reset(): void {
	for (let f of busy.state.files.values()) {
		try {
			liveFiles.close(f)
		} catch {}
	}
	busy.state.files.clear()
}

export const busy = {
	// `files`: each home's list, by path.
	state: { files: new Map<string, BusyFile>() },
	file,
	list,
	add,
	drop,
	starts,
	reset,
}
